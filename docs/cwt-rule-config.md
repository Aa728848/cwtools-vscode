# CWT Rule Configuration Guide / CWT 规则配置开发指南

[English](#english) | [中文](#zh-cn) | [Project Overview / 项目介绍](../README.md) | [Contribution Guide / 贡献指南](../CONTRIBUTING.md) | [Architecture / 架构文档](../ARCHITECTURE.md) | [Diagnostic Codes / 诊断码](diagnostic-codes.md)

<a id="english"></a>

## English

This page is the project wiki for CWT rule configuration developers. It documents the rule model used by this repository, the supported rule blocks and field expressions, and the difference between shared, Legacy/Clausewitz, Jomini/modern, and game-specific support.

The implementation source of truth is in:

- `submodules/cwtools/CWTools/Rules/RulesParser.fs`
- `submodules/cwtools/CWTools/Rules/RulesTypes.fs`
- `submodules/cwtools/CWTools/Rules/FieldValidators.fs`
- `submodules/cwtools/CWTools/Rules/InfoService.fs`
- `submodules/cwtools/CWTools/Rules/CompletionService.fs`
- `submodules/cwtools-stellaris-config/config/`

The format is inspired by reference-style rule documentation, but the semantics below describe this project rather than another tool's CWT dialect.

### Support Labels

Many CWT expressions are parsed by the shared parser, but useful validation or completion may require a specific game family or metadata source. This document uses these labels:

| Label | Meaning |
| --- | --- |
| Shared | Supported by the common CWTools rule stack and usable in both Legacy and Jomini-style profiles when the referenced data exists. |
| Legacy | Designed for Legacy/Clausewitz-style profiles such as Stellaris, HOI4, EU4, CK2, and VIC2. A modern profile may parse it but usually does not rely on it. |
| Jomini/Modern | Requires Jomini-style metadata, generated logs, or modern profile support. Legacy profiles may parse it but usually lack data to make it useful. |
| Game-specific | Implemented for one game or subsystem. Check existing rules and game validators before reusing it elsewhere. |
| Advanced | Supported, but intended for rule infrastructure or rare syntax. Prefer existing examples. |

When a row says "Shared; metadata-dependent", the parser and rule object are shared, but validation/completion only works if the profile provides the matching type map, enum, file index, database object metadata, or generated data.

### What CWT Rules Model

CWT rules do not describe game runtime behavior directly. They describe how the editor and language server should understand game files:

- Which folders are scanned.
- Which script blocks become typed definitions such as `event`, `building`, `sprite`, or `technology`.
- Which keys and values are legal inside each definition.
- Whether a value is a localisation key, type reference, enum, dynamic value, file path, scope chain, variable, asset, or alias.
- How `this`, `root`, `from`, and related scopes change inside nested blocks.
- Which localisation keys and image resources should exist for a definition.

The same rules drive diagnostics, completion, hover, go-to-definition, find-references, document symbols, dependency graphs, previews, AI tools, and the bundled read-only MCP server.

### Game Families

| Family | Examples | Notes |
| --- | --- | --- |
| Legacy/Clausewitz | Stellaris, Hearts of Iron IV, Europa Universalis IV, Crusader Kings II, Victoria II | Uses shared CWT plus legacy localisation command/link rules and game-specific generated logs. Stellaris is the primary rule source in this repository. |
| Jomini/Modern | Imperator: Rome, Crusader Kings III, Victoria 3, Europa Universalis V, Custom profiles | Uses shared CWT plus modern generated metadata such as effect/trigger/data-type logs, system scopes, database objects, and locale metadata. |

Use vanilla files and generated script documentation for the game you are targeting. Do not assume a field that works in Stellaris has meaningful data in a Jomini profile, or vice versa.

### File Layout

The editable Stellaris rule source is:

```text
submodules/cwtools-stellaris-config/config/
```

| Path | Purpose | Support |
| --- | --- | --- |
| `folders.cwt` | Known folders and folder classification. | Shared |
| `scopes.cwt` | Scope names, aliases, inheritance, and scope groups. | Shared |
| `links.cwt` | Scope links such as `owner`, `planet`, `solar_system`. | Shared |
| `effects.cwt` / `triggers.cwt` | Built-in and scripted effect/trigger aliases. | Legacy in Stellaris; concept shared |
| `scope_changes.cwt` | Complex scope transitions and scripted lists. | Legacy/Stellaris |
| `enums.cwt` | Static and complex enums. | Shared |
| `localisation.cwt` | Legacy localisation commands, localisation links, and name aliases. | Legacy |
| `modifier*.cwt` | Modifier categories, modifier rule shapes, and modifier aliases. | Shared with game-specific data |
| `events.cwt` | Event type rules, event declarations, and pre-triggers. | Legacy/Stellaris |
| `common/**/*.cwt` | Rules for `common/` definitions. | Shared shape; game-specific content |
| `gfx/**/*.cwt`, `interface/**/*.cwt` | GFX, GUI, sprite, and asset rules. | Shared shape; asset subsystem specific |
| `sound/**/*.cwt` | Sound and advisor voice rules. | Game-specific |
| `logs/*.log` | Generated or copied reference data from game documentation. | Game-specific |

Do not edit `release/rules/stellaris-rules.zip` directly. It is generated packaging output.

### Basic Syntax

CWT uses Paradox-style key/value and block syntax:

```cwt
key = value
key = {
    child = value
}
```

Duplicate keys are meaningful. They usually represent alternative rules:

```cwt
id = <event.country>
id = <event.planet>
days = int
days = value_field
```

Comment prefixes have different meanings:

| Prefix | Meaning | Support |
| --- | --- | --- |
| `#` | Ordinary maintainer comment. | Shared |
| `###` | Documentation comment shown in completion/hover. | Shared |
| `##` | Rule option attached to the next rule. | Shared |

Keep `##` options directly adjacent to the rule they configure.

### Declaration Rules

Declaration rules describe the structure inside script blocks.

#### Property Rules

```cwt
name = localisation
icon = <sprite>
enabled = bool
count = int[0..100]
```

Both the left side and the right side may be field expressions. Prefer precise fields over `scalar` whenever the game syntax has meaning.

#### Block Rules

```cwt
potential = {
    alias_name[trigger] = alias_match_left[trigger]
}
```

Use `## push_scope` or `## replace_scopes` when the nested block changes the scope context.

#### Leaf Value Rules

```cwt
allowed_archetypes = {
    ## cardinality = 0..100
    enum[species_archetype]
}
```

This matches script like:

```txt
allowed_archetypes = { BIOLOGICAL ROBOT }
```

Leaf value rules can use type references, localisation fields, sprite references, enums, scopes, and `prefix_field[...]`.

#### Value Clause Rules

Value clauses are parsed as lightweight syntax trees and become `ValueClauseRule`. They are supported by the parser, but normal rule authors should copy existing examples rather than inventing new value-clause shapes.

Support: Advanced.

#### Subtype Rules

```cwt
subtype[planet] = {
    planet_only = bool
}

subtype[!planet] = {
    non_planet_only = bool
}
```

`subtype[x]` is active when the current definition matches subtype `x`. `subtype[!x]` is active when it does not.

Support: Shared.

### Rule Options

Rule options are `##` comments attached to the following rule.

| Option | Example | Meaning | Support |
| --- | --- | --- | --- |
| `## cardinality` | `## cardinality = 0..1` | Allowed count. Default is `1..1`; `inf` means unbounded. | Shared |
| `## severity` | `## severity = warning` | Override diagnostic severity for this rule. | Shared |
| `## scope` | `## scope = country` | Restrict the input scope in which a rule is valid. | Shared |
| `## push_scope` | `## push_scope = planet` | Enter a new `this` scope when matching a block. | Shared |
| `## replace_scope` / `## replace_scopes` | `## replace_scopes = { this = country root = country from = planet }` | Replace system scopes inside the nested rule. | Shared |
| `## completion_type` | `## completion_type = modifier` | Use completions from a specific type. | Shared; metadata-dependent |
| `## error_if_only_match` | `## error_if_only_match = use x instead` | Report a custom error when only this rule matches. | Shared |
| `## type_prefix_from` | `## type_prefix_from = key` | Derive type prefix context from another field. | Advanced |
| `## type_suffix_pattern(s)` | `## type_suffix_patterns = { _desc _tooltip }` | Add suffix-derived type completion candidates. | Shared |
| `## file_extensions` | `## file_extensions = { dds png }` | Restrict file completion extensions. | Shared |
| `## color_type` | `## color_type = hsv360` | Adjust generated `colour_field` / `color_field` rules. | Shared |
| `## inject` | `## inject = common/foo.cwt@type/path` | Inject child rules from another rule file. | Advanced |
| `## incomingReferenceLabel` | `## incomingReferenceLabel = uses` | Label incoming reference relationships. | Advanced |
| `## outgoingReferenceLabel` | `## outgoingReferenceLabel = references` | Label outgoing reference relationships. | Advanced |

`## cardinality = ~1..1` uses a non-strict minimum. This is supported for compatibility but should be rare.

### Field Expression Support Matrix

| Category | Expressions | Support |
| --- | --- | --- |
| Basic scalar/value | `scalar`, `wildcard_scalar`, `$any`, literal strings, `bool`, `int`, `float`, `date_field`, `datetime_field`, `percentage_field` | Shared |
| Static enums | `enum[name]` | Shared; enum must exist |
| Type references | `<type>`, `prefix<type>suffix` | Shared; type must exist |
| Localisation values | `localisation`, `localisation_synced`, `localisation_inline` | Shared; validation behavior differs by profile |
| Prefixed value references | `prefix_field[localisation]`, `prefix_field[<sprite>]` | Shared |
| Files/resources | `filepath[...]`, `filename[...]`, `abs_filepath`, `icon[...]` | Shared; file index required |
| Colours | `colour_field`, `color_field`, `colour[...]`, `color[...]` | Shared |
| Scopes | `scope[...]`, `scope_field`, `scope_group[...]`, `event_target[...]` | Shared; scope data required |
| Dynamic values and variables | `value_field`, `int_value_field`, `variable_field`, `value[...]`, `value_set[...]`, `dynamic_value[...]` | Shared; formula/value expansion can be profile-specific |
| Aliases | `alias_name[...]`, `alias_match_left[...]`, `single_alias_right[...]`, `alias_keys_field[...]`, `alias_params_field[...]` | Shared |
| Localisation parameters | `$localisation_parameter` | Shared; most useful in profiles with parameterised localisation |
| Script/database helpers | `$script_value_reference`, `$define_reference`, `$array_define_reference`, `$database_object`, `$tags[...]`, `$tags_condition[...]` | Mixed; see details |
| Shader/mesh/technology helpers | `$shader_effect`, `$mesh_locator`, `$technology_with_level` | Game-specific |
| Patterns | `glob:`, `glob.i:`, `ant:`, `ant.i:`, `re:`, `re.i:` | Shared |
| Jomini GUI-prefixed nodes | GUI nodes with key/value prefixes | Jomini/Modern |
| Ignore marker | `ignore_field` | Advanced |

### Field Expression Details

#### Basic Values

| Expression | Meaning | Support |
| --- | --- | --- |
| `scalar`, `wildcard_scalar`, `$any` | Any scalar value. | Shared |
| `bool` | `yes` or `no`. | Shared |
| `int`, `int[min..max]`, `int(min..max)` | Integer, optionally ranged. | Shared |
| `float`, `float[min..max]`, `float(min..max)` | Decimal value, optionally ranged. | Shared |
| `percentage_field`, `int_percentage_field` | Percent value field. | Shared |
| `date_field`, `date_field[...]`, `date_field(...)` | Date value. | Shared |
| `datetime_field`, `datetime_field[...]`, `datetime_field(...)` | Date/time value. | Shared |
| A normal string | Exact literal match. | Shared |

Avoid `scalar` when a value can be validated more precisely. `scalar` disables useful completion and reference checks.

#### Enums

```cwt
category = enum[scripted_modifier_categories]
```

`enum[name]` uses a static enum from `enums = { enum[name] = { ... } }`.

Support: Shared.

#### Type References

```cwt
icon = <sprite>
event = <event>
asset = "GFX_<sprite>_frame"
```

| Expression | Meaning | Support |
| --- | --- | --- |
| `<type>` | Reference a definition type. | Shared |
| `prefix<type>suffix` | Reference a definition type embedded in a fixed string. | Shared |

Type references provide validation, completion, go-to-definition, find-references, and graph edges.

#### Localisation

| Expression | Meaning | Support |
| --- | --- | --- |
| `localisation` | Normal localisation key. | Shared |
| `localisation_synced` | Synced/default-language localisation key. | Shared; profile behavior differs |
| `localisation_inline` | Inline localisation text/key. | Shared |
| `$localisation_parameter` | Localisation parameter expression. | Shared; parameter metadata dependent |

Legacy profiles commonly use `localisation.cwt` command/link rules. Jomini profiles commonly use generated data-type metadata.

#### Prefixed Fields

`prefix_field[...]` supports script values shaped like `prefix:value`, while validating and completing the part after the colon.

```cwt
override_text = {
    localisation
    prefix_field[localisation]
}

override_texture = {
    <sprite>
    prefix_field[<sprite>]
}
```

This supports:

```txt
override_text = { text:TIMELINE_EVENT_START }
override_texture = { background:GFX_evt_supernova origin_icon:GFX_origin_default }
```

Support: Shared.

Do not add `scalar` beside these rules unless the game truly accepts arbitrary text. A `scalar` fallback can hide missing localisation or missing sprite diagnostics.

#### Files, Assets, and Colours

| Expression | Meaning | Support |
| --- | --- | --- |
| `filepath` | Any known file path. | Shared |
| `filepath[prefix]` | File path under a prefix. | Shared |
| `filepath[prefix,extension]` | File path under a prefix with extension restriction. | Shared |
| `filename` | File name. | Shared |
| `filename[prefix]` | File name under a prefix. | Shared |
| `abs_filepath`, `absolute_filepath` | Absolute path. | Shared |
| `icon[folder]` | Icon resource under a folder. | Game-specific file layout |
| `colour_field`, `color_field` | Generated colour rule. | Shared |
| `colour[rgb]`, `color[rgb]` | RGB colour values. | Shared |
| `colour[hsv]`, `color[hsv]` | HSV colour values. | Shared |

Use `## file_extensions` with file fields when only a few extensions are legal.

#### Scopes

| Expression | Meaning | Support |
| --- | --- | --- |
| `scope[type]` | Scope reference with a specific expected scope. | Shared |
| `scope_field` | Any scope chain. | Shared |
| `scope_group[name]` | A named group from `scope_groups`. | Shared |
| `event_target[type]` | Event target scope. | Shared; Legacy/Stellaris-heavy |

Use `## push_scope` or `## replace_scopes` when a block changes context. Use scope fields when a value itself is a scope chain.

#### Dynamic Values, Variables, and Script Values

| Expression | Meaning | Support |
| --- | --- | --- |
| `value_field`, `value_field[...]`, `value_field(...)` | Numeric expression or value-scope expression. | Shared; expansion profile-dependent |
| `int_value_field`, `int_value_field[...]`, `int_value_field(...)` | Integer value-scope expression. | Shared |
| `variable_field`, `variable_field[...]`, `variable_field(...)` | Variable or number. | Shared |
| `int_variable_field`, `int_variable_field[...]`, `int_variable_field(...)` | Integer variable or number. | Shared |
| `variable_field_32`, `int_variable_field_32` | 32-bit variants. | Shared |
| `value[name]` | Read from a dynamic value set. | Shared |
| `value_set[name]` | Write to a dynamic value set. | Shared |
| `dynamic_value[name]` | Dynamic value reference. | Shared |
| `$script_value_reference` | Script value reference. | Shared; data-dependent |

#### Aliases

| Expression | Meaning | Support |
| --- | --- | --- |
| `alias_name[group]` | Expand all aliases in a group at this position. | Shared |
| `alias_match_left[group]` | Match the left side of an alias in a group. | Shared |
| `alias_keys_field[group]` | Complete/validate keys from an alias group. | Shared |
| `alias_params_field[group]` | Resolve alias parameters using a sibling selector of the same name. | Advanced |
| `alias_params_field[group,selector]` | Resolve alias parameters with an explicit selector field. | Advanced |
| `single_alias_right[name]` | Reuse the right side of a single alias. | Shared |
| `clause_single_alias[name] = single_alias_right[x]` | Bridge a value clause to a single alias. | Advanced |

Common trigger/effect pattern:

```cwt
trigger = {
    alias_name[trigger] = alias_match_left[trigger]
}
```

#### Script, Database, and Tags

| Expression | Meaning | Support |
| --- | --- | --- |
| `$command` | Command expression. | Shared |
| `$define_reference` | Define reference. | Shared; data-dependent |
| `$array_define_reference` | Array define reference. | Shared; data-dependent |
| `$database_object` | Database object reference. | Jomini/Modern; requires `database_object_types` |
| `$tags[name]` | Tag value. | Shared; tag metadata-dependent |
| `$tags_condition[name]` | Conditional tag value. | Shared; tag metadata-dependent |

#### Game-Specific Helpers

| Expression | Meaning | Support |
| --- | --- | --- |
| `$shader_effect` | PDX shader effect expression. | Game-specific shader subsystem |
| `$mesh_locator` | Mesh locator expression. | Game-specific asset subsystem |
| `$technology_with_level` | Stellaris technology-with-level expression. | Game-specific/Stellaris |
| `name_format[type]` | Name format expression. | Game-specific |
| `stellaris_name_format[type]` | Stellaris name format. | Game-specific/Stellaris |
| `portrait_dna_field` | CK2 portrait DNA. | Game-specific/CK2 |
| `portrait_properties_field` | CK2 portrait properties. | Game-specific/CK2 |
| `ir_country_tag_field` | Imperator country tag. | Game-specific/IR |
| `ir_family_name_field` | Imperator family name. | Game-specific/IR |

Do not use these in a shared rule unless the profile actually provides the corresponding validator and data.

#### Pattern Fields

| Expression | Meaning | Support |
| --- | --- | --- |
| `glob:pattern` | Glob pattern, case-sensitive. | Shared |
| `glob.i:pattern` | Glob pattern, case-insensitive. | Shared |
| `ant:pattern` | ANT path pattern, case-sensitive. | Shared |
| `ant.i:pattern` | ANT path pattern, case-insensitive. | Shared |
| `re:pattern` | Regex pattern, case-sensitive. | Shared |
| `re.i:pattern` | Regex pattern, case-insensitive. | Shared |

### Type Rules

Type rules tell the language server how to discover definitions:

```cwt
types = {
    type[building] = {
        path = "game/common/buildings"
        path_extension = .txt
        localisation = {
            ## primary
            name = "$"
            desc = "$_desc"
        }
    }
}
```

| Field or option | Meaning | Support |
| --- | --- | --- |
| `path` | Directory to scan. `game/` is stripped during parsing. | Shared |
| `path_strict = yes` | Do not match subdirectories. | Shared |
| `path_file` | Restrict to a specific file name. | Shared |
| `path_extension` | Restrict to an extension. | Shared |
| `skip_root_key` | Skip a wrapping root key. | Shared |
| `name_field` | Read display/definition name from a field in the body. | Shared |
| `type_per_file = yes` | Treat a whole file as one definition. | Shared |
| `type_key_prefix` | Require a key prefix. | Shared |
| `starts_with` | Require a key prefix for discovery. | Shared |
| `## type_key_filter` | Key allow/deny filter. | Shared |
| `## type_key_regex` | Regex key filter. | Shared |
| `unique = yes` | Report duplicate definitions. | Shared |
| `severity = warning` | Use warning severity for type diagnostics. | Shared |
| `should_be_used = yes` | Definition should have references. | Shared |
| `should_be_used = unless_subtyped` | Require references unless a subtype matched. | Shared |
| `error_unknown_keys = yes` | Unknown root keys are errors. | Shared |
| `error_unknown_keys = suggest` | Unknown root keys produce suggestions. | Shared |
| `obsolete_keys` | Mark keys obsolete and provide migration text. | Shared |

Subtype example:

```cwt
types = {
    type[event] = {
        path = "game/events"
        path_extension = .txt

        ## type_key_filter = country_event
        ## push_scope = country
        ## display_name = Country Event
        subtype[country] = {}
    }
}
```

Subtypes are Shared. Their specific meaning is game-dependent because event keys and scopes differ by game.

### Enums and Dynamic Values

Static enum:

```cwt
enums = {
    enum[scope_type_tokens] = {
        country
        planet
        fleet
    }
}
```

Complex enum:

```cwt
enums = {
    complex_enum[district_sets] = {
        path = "game/common/districts"
        path_extension = .txt
        name = {
            # name tree
        }
    }
}
```

Dynamic value set:

```cwt
values = {
    value[my_values] = {
        value_a
        value_b
    }
}
```

Support: Shared. Complex enums depend on correct path and name extraction.

### Aliases and Reuse

Alias definition:

```cwt
alias[effect:add_resource] = {
    resource = <resource>
    amount = value_field
}
```

Alias expansion:

```cwt
immediate = {
    alias_name[effect] = alias_match_left[effect]
}
```

Support: Shared.

Use aliases when a structure appears in several files or represents a stable game concept. Avoid broad catch-all aliases that hide the domain meaning.

### Scopes and Links

Scopes:

```cwt
scopes = {
    country = {
        aliases = { Country country }
    }
    planet = {
        is_subscope_of = { colony }
    }
}
```

Scope groups:

```cwt
scope_groups = {
    celestial_coordinate = {
        planet
        galactic_object
    }
}
```

Links:

```cwt
links = {
    owner = {
        input_scopes = { planet ship fleet }
        output_scope = country
    }
}
```

| Block/field | Meaning | Support |
| --- | --- | --- |
| `scopes` | Scope names and metadata. | Shared |
| `aliases` | Alternate names for a scope. | Shared |
| `is_subscope_of` | Scope inheritance/compatibility. | Shared |
| `data_type_name` | Associate a scope with a data type. | Jomini/Modern |
| `scope_groups` | Named reusable scope sets. | Shared |
| `links` | Scope/value link definitions. | Shared |
| `input_scope`, `input_scopes` | Valid source scopes. | Shared |
| `output_scope` | Link result scope. | Shared |
| `type = scope/value/both` | Link kind. | Shared |
| `data_source`, `from_data`, `from_argument`, `argument_separator` | Data-driven link metadata. | Jomini/Modern |
| `for_definition_type` | Restrict a link to a definition type. | Jomini/Modern |
| `desc` | Link documentation. | Shared |

### Localisation

Declaration rules use localisation field expressions:

```cwt
name = localisation
desc = localisation
```

Type display localisation:

```cwt
types = {
    type[building] = {
        localisation = {
            ## primary
            name = "$"
            desc = "$_desc"
        }
    }
}
```

Legacy localisation command/link rules:

```cwt
localisation_commands = {
    GetName = {}
}

localisation_links = {
    Owner = {
        input_scopes = { planet ship }
        output_scope = country
    }
}
```

| Construct | Support |
| --- | --- |
| `localisation`, `localisation_synced`, `localisation_inline` fields | Shared |
| Type-level `localisation` display rules | Shared |
| `localisation_commands` | Legacy |
| `localisation_links` | Legacy |
| Jomini data-type localisation functions/promotes | Jomini/Modern, generated metadata dependent |

### Resources and Display Metadata

Images:

```cwt
types = {
    type[building] = {
        images = {
            ## primary
            icon = "gfx/interface/icons/buildings/$.dds"
        }
    }
}
```

Type-level modifiers:

```cwt
types = {
    type[resource] = {
        modifiers = {
            planet_$ = planet
        }
    }
}
```

Modifier categories:

```cwt
modifier_categories = {
    planet = {
        supported_scopes = { planet country }
    }
}
```

| Construct | Support |
| --- | --- |
| Type-level `images` | Shared; file layout dependent |
| Type-level `modifiers` | Shared; modifier category data dependent |
| `modifier_categories` | Shared; game data dependent |
| `supported_scopes` | Shared |
| `internal_id` | Game-specific/advanced |

### Extended Metadata

| Block | Meaning | Support |
| --- | --- | --- |
| `priorities` | File override strategy metadata; path keys also drive editor hover override-mode display. | Jomini/Modern; path-prefix matching uses the longest configured path |
| `override_modes_info` | Optional legend documenting each override strategy (`LIOS`, `FIOS`, `DUPL`, `NO`, `MERGE`, `UNKNOWN`, ...): `name` tag plus plain-text `## ` comment descriptions inside each mode block (meaning / who wins by default / how to override vanilla). Avoid option-style `=` examples in those description comments. Surfaced to the AI agent via `query_override_modes` -> `modeInfo` / `matchedModeInfo`. | Jomini/Modern; parsed from `## ` comments |
| `system_scopes` | Metadata for `This`, `Root`, `Prev`, `From`, etc. | Jomini/Modern |
| `locales` | Locale ids and language codes. | Jomini/Modern |
| `database_object_types` | Metadata for `$database_object`. | Jomini/Modern |
| `on_actions` | on_action event type hints and scope replacements. | Jomini/Modern; Stellaris may keep generated/static equivalents in normal rules |

Example:

```cwt
database_object_types = {
    concept = {
        type = concept
        localisation = concept_
        swap_type = concept_group
    }
}
```

### Authoring Workflow

1. Find vanilla examples in the target game.
2. Decide the semantic type: localisation, type reference, enum, scope, file, dynamic value, or arbitrary scalar.
3. Search existing rules with `rg` and reuse local patterns.
4. Write the narrowest rule possible.
5. Add `## cardinality`.
6. Add `## push_scope` or `## replace_scopes` when blocks change scope context.
7. Avoid `scalar` fallbacks beside real references unless arbitrary text is valid.
8. Run rule checks and builds.

### Common Patterns

Optional field:

```cwt
## cardinality = 0..1
name = localisation
```

List field:

```cwt
targets = {
    ## cardinality = 0..inf
    scope[any]
}
```

Fixed value or script value:

```cwt
days = int
days = value_field
```

Prefixed localisation or sprite:

```cwt
text = {
    localisation
    prefix_field[localisation]
}

texture = {
    <sprite>
    prefix_field[<sprite>]
}
```

Trigger/effect block:

```cwt
potential = {
    alias_name[trigger] = alias_match_left[trigger]
}
```

### Verification

For Stellaris rule changes:

```bash
npm run rules:stellaris:check
dotnet build src/Main/
```

For parser or field semantics changes:

```bash
dotnet build src/LSP/
dotnet build src/Main/
```

For documentation:

```bash
npm run build:docs
```

For broad release verification:

```bash
npm run verify
```

`submodules/cwtools/` and `submodules/cwtools-stellaris-config/` are separate git repositories. Commit inside a submodule first, then commit the updated pointer in the root repository.

### Field Choice Quick Reference

| Need | Prefer | Avoid |
| --- | --- | --- |
| yes/no | `bool` | `scalar` |
| bounded number | `int[...]`, `float[...]` | unbounded `scalar` |
| localisation key | `localisation` | `scalar` |
| `text:KEY` | `prefix_field[localisation]` | `scalar` |
| sprite id | `<sprite>` | `scalar` |
| `background:GFX_x` | `prefix_field[<sprite>]` | `scalar` |
| definition reference | `<type>` | `enum[...]` or `scalar` |
| fixed value set | `enum[name]` | many unrelated literals |
| arbitrary scope chain | `scope_field` | `scalar` |
| specific scope reference | `scope[type]` | `scope_field` when too broad |
| file path | `filepath[...]` | `scalar` |
| colour | `colour_field` / `color_field` | manual repeated float rules |
| effect/trigger list | `alias_name[...] = alias_match_left[...]` | copying every alias into each block |

### Implementation Checklist

When adding a field expression or changing field semantics, check:

| File | Why |
| --- | --- |
| `RulesTypes.fs` | New `NewField` union case if needed. |
| `RulesParser.fs` | `processKey`, rule parsing, and rule consistency. |
| `FieldValidators.fs` | Validation and non-empty checks. |
| `InfoService.fs` | Reference extraction and hover/go-to-definition. |
| `CompletionService.fs` | LHS/RHS/leaf-value completion. |
| `submodules/cwtools-stellaris-config/config/` | Rule data using the new expression. |

<a id="zh-cn"></a>

## 中文

本文档是本项目的 CWT 规则配置开发者 wiki。它说明本仓库使用的规则模型、支持的规则块和字段表达式，以及哪些能力属于通用、Legacy/Clausewitz、Jomini/现代或游戏特定支持。

实现上的事实来源是：

- `submodules/cwtools/CWTools/Rules/RulesParser.fs`
- `submodules/cwtools/CWTools/Rules/RulesTypes.fs`
- `submodules/cwtools/CWTools/Rules/FieldValidators.fs`
- `submodules/cwtools/CWTools/Rules/InfoService.fs`
- `submodules/cwtools/CWTools/Rules/CompletionService.fs`
- `submodules/cwtools-stellaris-config/config/`

本文组织方式参考规则格式参考类文档，但字段、语义和支持范围按本项目实现重新整理。

### 支持范围标记

很多 CWT 表达式由共享解析器解析，但真正的校验、补全或引用提取可能依赖某个游戏家族或元数据来源。本文使用这些标记：

| 标记 | 含义 |
| --- | --- |
| Shared | 由通用 CWTools 规则栈支持。只要引用的数据存在，就可在 Legacy 和 Jomini 风格 profile 中使用。 |
| Legacy | 面向 Legacy/Clausewitz 风格 profile，例如 Stellaris、HOI4、EU4、CK2、VIC2。现代 profile 可能能解析，但通常不依赖它。 |
| Jomini/Modern | 需要 Jomini 风格元数据、生成日志或现代 profile 支持。Legacy profile 可能能解析，但通常没有数据让它发挥作用。 |
| Game-specific | 面向某个游戏或子系统。跨游戏复用前必须检查现有规则和验证器。 |
| Advanced | 已支持，但主要用于规则基础设施或罕见语法。优先参考现有例子。 |

如果某一行写着“Shared; metadata-dependent”，表示解析和规则对象是通用的，但校验/补全依赖 profile 是否提供对应的类型表、枚举、文件索引、database object 元数据或生成数据。

### CWT 规则描述什么

CWT 规则不直接描述游戏运行时逻辑。它描述编辑器和语言服务器如何理解游戏文件：

- 哪些文件夹会被扫描。
- 哪些脚本块会成为 `event`、`building`、`sprite`、`technology` 等类型定义。
- 每种定义内部允许哪些键和值。
- 某个值是不是本地化键、类型引用、枚举、动态值、文件路径、作用域链、变量、资产或 alias。
- 嵌套块中 `this`、`root`、`from` 及相关作用域如何变化。
- 某个定义应该有哪些本地化键和图片资源。

这些规则同时驱动诊断、补全、悬浮、跳转定义、查找引用、文档符号、依赖图、预览、AI 工具和随扩展分发的只读 MCP 服务。

### 游戏家族

| 家族 | 示例 | 说明 |
| --- | --- | --- |
| Legacy/Clausewitz | Stellaris、Hearts of Iron IV、Europa Universalis IV、Crusader Kings II、Victoria II | 使用共享 CWT，加上传统本地化命令/链接规则以及游戏特定生成日志。Stellaris 是本仓库主要规则源。 |
| Jomini/Modern | Imperator: Rome、Crusader Kings III、Victoria 3、Europa Universalis V、自定义 profile | 使用共享 CWT，加上现代生成元数据，例如 effect/trigger/data-type 日志、system scopes、database objects 和 locale 元数据。 |

写规则时应以目标游戏的 vanilla 文件和脚本文档为依据。不要假设 Stellaris 可用的字段在 Jomini profile 中也有同样数据，反过来也一样。

### 文件布局

Stellaris 可编辑规则源位于：

```text
submodules/cwtools-stellaris-config/config/
```

| 路径 | 用途 | 支持 |
| --- | --- | --- |
| `folders.cwt` | 已知文件夹和文件夹分类。 | Shared |
| `scopes.cwt` | 作用域名、别名、继承和作用域分组。 | Shared |
| `links.cwt` | `owner`、`planet`、`solar_system` 等作用域链接。 | Shared |
| `effects.cwt` / `triggers.cwt` | 内置和脚本化 effect/trigger alias。 | Stellaris 中是 Legacy；概念通用 |
| `scope_changes.cwt` | 复杂作用域变换和脚本列表。 | Legacy/Stellaris |
| `enums.cwt` | 静态枚举和复杂枚举。 | Shared |
| `localisation.cwt` | 传统本地化命令、本地化链接和名称相关 alias。 | Legacy |
| `modifier*.cwt` | modifier 类别、modifier 规则形状和 modifier alias。 | Shared，内容依赖游戏数据 |
| `events.cwt` | 事件类型规则、事件声明和 pre-trigger。 | Legacy/Stellaris |
| `common/**/*.cwt` | `common/` 下定义的规则。 | 形状 Shared，内容游戏特定 |
| `gfx/**/*.cwt`、`interface/**/*.cwt` | GFX、GUI、sprite 和 asset 规则。 | 形状 Shared，资源子系统特定 |
| `sound/**/*.cwt` | 音频和 advisor voice 规则。 | Game-specific |
| `logs/*.log` | 从游戏文档生成或复制的参考数据。 | Game-specific |

不要直接编辑 `release/rules/stellaris-rules.zip`。它是打包产物。

### 基础语法

CWT 使用 Paradox 风格键值和块语法：

```cwt
key = value
key = {
    child = value
}
```

重复键是有意义的，通常表示候选规则：

```cwt
id = <event.country>
id = <event.planet>
days = int
days = value_field
```

注释前缀有不同语义：

| 前缀 | 含义 | 支持 |
| --- | --- | --- |
| `#` | 普通维护注释。 | Shared |
| `###` | 显示在补全/悬浮中的文档注释。 | Shared |
| `##` | 附着在下一条规则上的规则选项。 | Shared |

`##` 选项必须紧贴它要配置的规则。

### 声明规则

声明规则描述脚本块内部结构。

#### 属性规则

```cwt
name = localisation
icon = <sprite>
enabled = bool
count = int[0..100]
```

左侧和右侧都可以是字段表达式。只要游戏语法有明确语义，就优先使用具体字段，不要用 `scalar`。

#### 块规则

```cwt
potential = {
    alias_name[trigger] = alias_match_left[trigger]
}
```

如果嵌套块会改变作用域上下文，使用 `## push_scope` 或 `## replace_scopes`。

#### 裸值规则

```cwt
allowed_archetypes = {
    ## cardinality = 0..100
    enum[species_archetype]
}
```

它匹配：

```txt
allowed_archetypes = { BIOLOGICAL ROBOT }
```

裸值规则可以使用类型引用、本地化字段、sprite 引用、枚举、作用域和 `prefix_field[...]`。

#### value clause 规则

value clause 会被解析成轻量语法树并转成 `ValueClauseRule`。解析器支持它，但普通规则开发者应复制已有例子，不建议自己发明新的 value clause 形状。

支持：Advanced。

#### subtype 规则

```cwt
subtype[planet] = {
    planet_only = bool
}

subtype[!planet] = {
    non_planet_only = bool
}
```

`subtype[x]` 在当前定义匹配子类型 `x` 时生效。`subtype[!x]` 在未匹配 `x` 时生效。

支持：Shared。

### 规则选项

规则选项是附着到下一条规则上的 `##` 注释。

| 选项 | 示例 | 含义 | 支持 |
| --- | --- | --- | --- |
| `## cardinality` | `## cardinality = 0..1` | 允许出现次数。默认 `1..1`，`inf` 表示无限。 | Shared |
| `## severity` | `## severity = warning` | 覆盖该规则诊断等级。 | Shared |
| `## scope` | `## scope = country` | 限制规则在哪些输入作用域下合法。 | Shared |
| `## push_scope` | `## push_scope = planet` | 匹配块时进入新的 `this` 作用域。 | Shared |
| `## replace_scope` / `## replace_scopes` | `## replace_scopes = { this = country root = country from = planet }` | 替换嵌套规则内的系统作用域。 | Shared |
| `## completion_type` | `## completion_type = modifier` | 使用指定类型的补全。 | Shared；依赖元数据 |
| `## error_if_only_match` | `## error_if_only_match = use x instead` | 当只有此规则匹配时报自定义错误。 | Shared |
| `## type_prefix_from` | `## type_prefix_from = key` | 从另一个字段推导类型前缀上下文。 | Advanced |
| `## type_suffix_pattern(s)` | `## type_suffix_patterns = { _desc _tooltip }` | 为类型补全添加后缀候选。 | Shared |
| `## file_extensions` | `## file_extensions = { dds png }` | 限制文件补全扩展名。 | Shared |
| `## color_type` | `## color_type = hsv360` | 调整 `colour_field` / `color_field` 生成规则。 | Shared |
| `## inject` | `## inject = common/foo.cwt@type/path` | 从另一个规则文件注入子规则。 | Advanced |
| `## incomingReferenceLabel` | `## incomingReferenceLabel = uses` | 给入向引用关系加标签。 | Advanced |
| `## outgoingReferenceLabel` | `## outgoingReferenceLabel = references` | 给出向引用关系加标签。 | Advanced |

`## cardinality = ~1..1` 表示非严格最小值。支持它是为了兼容，正常规则中应少用。

### 字段表达式支持矩阵

| 类别 | 表达式 | 支持 |
| --- | --- | --- |
| 基础标量/值 | `scalar`、`wildcard_scalar`、`$any`、字面量、`bool`、`int`、`float`、`date_field`、`datetime_field`、`percentage_field` | Shared |
| 静态枚举 | `enum[name]` | Shared；枚举必须存在 |
| 类型引用 | `<type>`、`prefix<type>suffix` | Shared；类型必须存在 |
| 本地化值 | `localisation`、`localisation_synced`、`localisation_inline` | Shared；校验行为因 profile 而异 |
| 带前缀值引用 | `prefix_field[localisation]`、`prefix_field[<sprite>]` | Shared |
| 文件/资源 | `filepath[...]`、`filename[...]`、`abs_filepath`、`icon[...]` | Shared；依赖文件索引 |
| 颜色 | `colour_field`、`color_field`、`colour[...]`、`color[...]` | Shared |
| 作用域 | `scope[...]`、`scope_field`、`scope_group[...]`、`event_target[...]` | Shared；依赖作用域数据 |
| 动态值和变量 | `value_field`、`int_value_field`、`variable_field`、`value[...]`、`value_set[...]`、`dynamic_value[...]` | Shared；公式/值扩展可能依赖 profile |
| 别名 | `alias_name[...]`、`alias_match_left[...]`、`single_alias_right[...]`、`alias_keys_field[...]`、`alias_params_field[...]` | Shared |
| 本地化参数 | `$localisation_parameter` | Shared；在参数化本地化 profile 中最有用 |
| 脚本/database 辅助 | `$script_value_reference`、`$define_reference`、`$array_define_reference`、`$database_object`、`$tags[...]`、`$tags_condition[...]` | 混合；见下文 |
| shader/mesh/technology 辅助 | `$shader_effect`、`$mesh_locator`、`$technology_with_level` | Game-specific |
| 模式 | `glob:`、`glob.i:`、`ant:`、`ant.i:`、`re:`、`re.i:` | Shared |
| Jomini GUI 前缀节点 | 带 key/value prefix 的 GUI 节点 | Jomini/Modern |
| 忽略标记 | `ignore_field` | Advanced |

### 字段表达式详解

#### 基础值

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `scalar`、`wildcard_scalar`、`$any` | 任意标量值。 | Shared |
| `bool` | `yes` 或 `no`。 | Shared |
| `int`、`int[min..max]`、`int(min..max)` | 整数，可带范围。 | Shared |
| `float`、`float[min..max]`、`float(min..max)` | 小数，可带范围。 | Shared |
| `percentage_field`、`int_percentage_field` | 百分比值字段。 | Shared |
| `date_field`、`date_field[...]`、`date_field(...)` | 日期值。 | Shared |
| `datetime_field`、`datetime_field[...]`、`datetime_field(...)` | 日期时间值。 | Shared |
| 普通字符串 | 精确匹配字面量。 | Shared |

当值可以更精确地验证时，不要用 `scalar`。`scalar` 会让补全和引用检查失效。

#### 枚举

```cwt
category = enum[scripted_modifier_categories]
```

`enum[name]` 使用 `enums = { enum[name] = { ... } }` 中的静态枚举。

支持：Shared。

#### 类型引用

```cwt
icon = <sprite>
event = <event>
asset = "GFX_<sprite>_frame"
```

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `<type>` | 引用一个定义类型。 | Shared |
| `prefix<type>suffix` | 引用嵌入固定字符串中的定义类型。 | Shared |

类型引用提供校验、补全、跳转定义、查找引用和关系图边。

#### 本地化

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `localisation` | 普通本地化键。 | Shared |
| `localisation_synced` | 同步/默认语言本地化键。 | Shared；行为因 profile 而异 |
| `localisation_inline` | 内联本地化文本或键。 | Shared |
| `$localisation_parameter` | 本地化参数表达式。 | Shared；依赖参数元数据 |

Legacy profile 常使用 `localisation.cwt` 中的命令/链接规则。Jomini profile 常使用生成的 data-type 元数据。

#### 带前缀字段

`prefix_field[...]` 支持 `prefix:value` 形式，但校验和补全冒号后的 `value`。

```cwt
override_text = {
    localisation
    prefix_field[localisation]
}

override_texture = {
    <sprite>
    prefix_field[<sprite>]
}
```

可支持：

```txt
override_text = { text:TIMELINE_EVENT_START }
override_texture = { background:GFX_evt_supernova origin_icon:GFX_origin_default }
```

支持：Shared。

除非游戏真的接受任意文本，否则不要在这些规则旁边加 `scalar`。`scalar` 兜底会掩盖缺失本地化或缺失 sprite 诊断。

#### 文件、资产和颜色

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `filepath` | 任意已知文件路径。 | Shared |
| `filepath[prefix]` | 指定前缀下的文件路径。 | Shared |
| `filepath[prefix,extension]` | 指定前缀和扩展名的文件路径。 | Shared |
| `filename` | 文件名。 | Shared |
| `filename[prefix]` | 指定前缀下的文件名。 | Shared |
| `abs_filepath`、`absolute_filepath` | 绝对路径。 | Shared |
| `icon[folder]` | 指定目录下的图标资源。 | Game-specific 文件布局 |
| `colour_field`、`color_field` | 生成颜色规则。 | Shared |
| `colour[rgb]`、`color[rgb]` | RGB 颜色值。 | Shared |
| `colour[hsv]`、`color[hsv]` | HSV 颜色值。 | Shared |

如果只允许少数扩展名，给文件字段加 `## file_extensions`。

#### 作用域

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `scope[type]` | 期待特定作用域的作用域引用。 | Shared |
| `scope_field` | 任意作用域链。 | Shared |
| `scope_group[name]` | 来自 `scope_groups` 的命名作用域集合。 | Shared |
| `event_target[type]` | 事件目标作用域。 | Shared；Legacy/Stellaris 使用较多 |

块改变上下文时用 `## push_scope` 或 `## replace_scopes`。值本身是作用域链时才用作用域字段。

#### 动态值、变量和脚本值

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `value_field`、`value_field[...]`、`value_field(...)` | 数值表达式或 value-scope 表达式。 | Shared；扩展依赖 profile |
| `int_value_field`、`int_value_field[...]`、`int_value_field(...)` | 整数 value-scope 表达式。 | Shared |
| `variable_field`、`variable_field[...]`、`variable_field(...)` | 变量或数字。 | Shared |
| `int_variable_field`、`int_variable_field[...]`、`int_variable_field(...)` | 整数变量或数字。 | Shared |
| `variable_field_32`、`int_variable_field_32` | 32-bit 变体。 | Shared |
| `value[name]` | 从动态值集合读取。 | Shared |
| `value_set[name]` | 写入动态值集合。 | Shared |
| `dynamic_value[name]` | 动态值引用。 | Shared |
| `$script_value_reference` | script value 引用。 | Shared；依赖数据 |

#### 别名

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `alias_name[group]` | 在当前位置展开某个 alias 组。 | Shared |
| `alias_match_left[group]` | 匹配 alias 组中的左侧。 | Shared |
| `alias_keys_field[group]` | 补全/校验 alias 组中的键。 | Shared |
| `alias_params_field[group]` | 用同名 sibling selector 解析 alias 参数。 | Advanced |
| `alias_params_field[group,selector]` | 用显式 selector 字段解析 alias 参数。 | Advanced |
| `single_alias_right[name]` | 复用 single alias 的右侧。 | Shared |
| `clause_single_alias[name] = single_alias_right[x]` | 将 value clause 桥接到 single alias。 | Advanced |

常见 trigger/effect 写法：

```cwt
trigger = {
    alias_name[trigger] = alias_match_left[trigger]
}
```

#### 脚本、database 和 tags

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `$command` | 命令表达式。 | Shared |
| `$define_reference` | define 引用。 | Shared；依赖数据 |
| `$array_define_reference` | array define 引用。 | Shared；依赖数据 |
| `$database_object` | database object 引用。 | Jomini/Modern；需要 `database_object_types` |
| `$tags[name]` | tag 值。 | Shared；依赖 tag 元数据 |
| `$tags_condition[name]` | 条件 tag 值。 | Shared；依赖 tag 元数据 |

#### 游戏特定辅助字段

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `$shader_effect` | PDX shader effect 表达式。 | Game-specific shader 子系统 |
| `$mesh_locator` | mesh locator 表达式。 | Game-specific 资产子系统 |
| `$technology_with_level` | Stellaris 科技+等级表达式。 | Game-specific/Stellaris |
| `name_format[type]` | 名称格式表达式。 | Game-specific |
| `stellaris_name_format[type]` | Stellaris 名称格式。 | Game-specific/Stellaris |
| `portrait_dna_field` | CK2 portrait DNA。 | Game-specific/CK2 |
| `portrait_properties_field` | CK2 portrait properties。 | Game-specific/CK2 |
| `ir_country_tag_field` | Imperator country tag。 | Game-specific/IR |
| `ir_family_name_field` | Imperator family name。 | Game-specific/IR |

除非 profile 确实提供对应验证器和数据，否则不要把这些字段放进共享规则。

#### 模式字段

| 表达式 | 含义 | 支持 |
| --- | --- | --- |
| `glob:pattern` | glob 模式，区分大小写。 | Shared |
| `glob.i:pattern` | glob 模式，忽略大小写。 | Shared |
| `ant:pattern` | ANT 路径模式，区分大小写。 | Shared |
| `ant.i:pattern` | ANT 路径模式，忽略大小写。 | Shared |
| `re:pattern` | 正则，区分大小写。 | Shared |
| `re.i:pattern` | 正则，忽略大小写。 | Shared |

### 类型规则

类型规则告诉语言服务器如何发现定义：

```cwt
types = {
    type[building] = {
        path = "game/common/buildings"
        path_extension = .txt
        localisation = {
            ## primary
            name = "$"
            desc = "$_desc"
        }
    }
}
```

| 字段或选项 | 含义 | 支持 |
| --- | --- | --- |
| `path` | 扫描目录。解析时会去掉 `game/`。 | Shared |
| `path_strict = yes` | 不匹配子目录。 | Shared |
| `path_file` | 限定文件名。 | Shared |
| `path_extension` | 限定扩展名。 | Shared |
| `skip_root_key` | 跳过包裹用根键。 | Shared |
| `name_field` | 从定义体某个字段读取展示/定义名。 | Shared |
| `type_per_file = yes` | 整个文件作为一个定义。 | Shared |
| `type_key_prefix` | 要求键前缀。 | Shared |
| `starts_with` | 发现定义时要求键前缀。 | Shared |
| `## type_key_filter` | 键白名单/黑名单。 | Shared |
| `## type_key_regex` | 正则键过滤。 | Shared |
| `unique = yes` | 报告重复定义。 | Shared |
| `severity = warning` | 类型诊断使用 warning。 | Shared |
| `should_be_used = yes` | 定义应该被引用。 | Shared |
| `should_be_used = unless_subtyped` | 未匹配子类型时要求引用。 | Shared |
| `error_unknown_keys = yes` | 未知根键报错。 | Shared |
| `error_unknown_keys = suggest` | 未知根键给建议。 | Shared |
| `obsolete_keys` | 标记废弃键并提供迁移文本。 | Shared |

子类型示例：

```cwt
types = {
    type[event] = {
        path = "game/events"
        path_extension = .txt

        ## type_key_filter = country_event
        ## push_scope = country
        ## display_name = Country Event
        subtype[country] = {}
    }
}
```

子类型本身是 Shared。具体含义依赖游戏，因为事件键和作用域随游戏变化。

### 枚举与动态值

静态枚举：

```cwt
enums = {
    enum[scope_type_tokens] = {
        country
        planet
        fleet
    }
}
```

复杂枚举：

```cwt
enums = {
    complex_enum[district_sets] = {
        path = "game/common/districts"
        path_extension = .txt
        name = {
            # name tree
        }
    }
}
```

动态值集合：

```cwt
values = {
    value[my_values] = {
        value_a
        value_b
    }
}
```

支持：Shared。复杂枚举依赖正确的路径和名称提取规则。

### 别名与复用

定义 alias：

```cwt
alias[effect:add_resource] = {
    resource = <resource>
    amount = value_field
}
```

展开 alias：

```cwt
immediate = {
    alias_name[effect] = alias_match_left[effect]
}
```

支持：Shared。

当结构在多个文件中出现，或代表稳定游戏概念时，适合抽成 alias。不要创建过宽的兜底 alias，让领域含义变模糊。

### 作用域与链接

作用域：

```cwt
scopes = {
    country = {
        aliases = { Country country }
    }
    planet = {
        is_subscope_of = { colony }
    }
}
```

作用域分组：

```cwt
scope_groups = {
    celestial_coordinate = {
        planet
        galactic_object
    }
}
```

链接：

```cwt
links = {
    owner = {
        input_scopes = { planet ship fleet }
        output_scope = country
    }
}
```

| 块/字段 | 含义 | 支持 |
| --- | --- | --- |
| `scopes` | 作用域名和元数据。 | Shared |
| `aliases` | 作用域别名。 | Shared |
| `is_subscope_of` | 作用域继承/兼容关系。 | Shared |
| `data_type_name` | 将作用域关联到 data type。 | Jomini/Modern |
| `scope_groups` | 可复用的命名作用域集合。 | Shared |
| `links` | 作用域/值链接定义。 | Shared |
| `input_scope`、`input_scopes` | 有效源作用域。 | Shared |
| `output_scope` | 链接结果作用域。 | Shared |
| `type = scope/value/both` | 链接类型。 | Shared |
| `data_source`、`from_data`、`from_argument`、`argument_separator` | 数据驱动链接元数据。 | Jomini/Modern |
| `for_definition_type` | 将 link 限定到某个定义类型。 | Jomini/Modern |
| `desc` | link 文档。 | Shared |

### 本地化

声明规则中使用本地化字段表达式：

```cwt
name = localisation
desc = localisation
```

类型展示本地化：

```cwt
types = {
    type[building] = {
        localisation = {
            ## primary
            name = "$"
            desc = "$_desc"
        }
    }
}
```

Legacy 本地化命令/链接规则：

```cwt
localisation_commands = {
    GetName = {}
}

localisation_links = {
    Owner = {
        input_scopes = { planet ship }
        output_scope = country
    }
}
```

| 构造 | 支持 |
| --- | --- |
| `localisation`、`localisation_synced`、`localisation_inline` 字段 | Shared |
| type-level `localisation` 展示规则 | Shared |
| `localisation_commands` | Legacy |
| `localisation_links` | Legacy |
| Jomini data-type 本地化 functions/promotes | Jomini/Modern，依赖生成元数据 |

### 资源与展示元数据

图片：

```cwt
types = {
    type[building] = {
        images = {
            ## primary
            icon = "gfx/interface/icons/buildings/$.dds"
        }
    }
}
```

type-level modifiers：

```cwt
types = {
    type[resource] = {
        modifiers = {
            planet_$ = planet
        }
    }
}
```

modifier categories：

```cwt
modifier_categories = {
    planet = {
        supported_scopes = { planet country }
    }
}
```

| 构造 | 支持 |
| --- | --- |
| type-level `images` | Shared；依赖文件布局 |
| type-level `modifiers` | Shared；依赖 modifier category 数据 |
| `modifier_categories` | Shared；依赖游戏数据 |
| `supported_scopes` | Shared |
| `internal_id` | Game-specific/advanced |

### 扩展元数据

| 块 | 含义 | 支持 |
| --- | --- | --- |
| `priorities` | 文件覆盖策略元数据；路径键也用于编辑器 hover 的覆盖模式显示。 | Jomini/Modern；路径前缀匹配采用最长配置路径 |
| `override_modes_info` | 可选的覆盖策略图例，说明每个策略（`LIOS`、`FIOS`、`DUPL`、`NO`、`MERGE`、`UNKNOWN` 等）：每个模式块内的 `name` 标签加上纯文本 `## ` 注释描述（含义 / 默认谁胜出 / 如何覆盖原版）。这些描述注释中避免写成带 `=` 的 option 风格示例。通过 `query_override_modes` -> `modeInfo` / `matchedModeInfo` 提供给 AI 代理。 | Jomini/Modern；从 `## ` 注释解析 |
| `system_scopes` | `This`、`Root`、`Prev`、`From` 等系统作用域元数据。 | Jomini/Modern |
| `locales` | locale id 和语言代码。 | Jomini/Modern |
| `database_object_types` | `$database_object` 的元数据。 | Jomini/Modern |
| `on_actions` | on_action 事件类型提示和作用域替换。 | Jomini/Modern；Stellaris 也可能在普通规则中维护生成/静态等价信息 |

示例：

```cwt
database_object_types = {
    concept = {
        type = concept
        localisation = concept_
        swap_type = concept_group
    }
}
```

### 规则开发流程

1. 在目标游戏中找 vanilla 示例。
2. 判断语义类型：本地化、类型引用、枚举、作用域、文件、动态值或任意标量。
3. 用 `rg` 搜索现有规则并复用本地模式。
4. 写最窄规则。
5. 添加 `## cardinality`。
6. 块改变作用域时添加 `## push_scope` 或 `## replace_scopes`。
7. 除非任意文本真的合法，否则不要用 `scalar` 作为真实引用旁边的兜底。
8. 运行规则检查和构建。

### 常见模式

可选字段：

```cwt
## cardinality = 0..1
name = localisation
```

列表字段：

```cwt
targets = {
    ## cardinality = 0..inf
    scope[any]
}
```

固定值或脚本值：

```cwt
days = int
days = value_field
```

带前缀本地化或 sprite：

```cwt
text = {
    localisation
    prefix_field[localisation]
}

texture = {
    <sprite>
    prefix_field[<sprite>]
}
```

trigger/effect 块：

```cwt
potential = {
    alias_name[trigger] = alias_match_left[trigger]
}
```

### 验证

Stellaris 规则改动：

```bash
npm run rules:stellaris:check
dotnet build src/Main/
```

解析器或字段语义改动：

```bash
dotnet build src/LSP/
dotnet build src/Main/
```

文档改动：

```bash
npm run build:docs
```

广义发布验证：

```bash
npm run verify
```

`submodules/cwtools/` 和 `submodules/cwtools-stellaris-config/` 是独立 git 仓库。提交时先在子模块内提交，再提交根仓库指针。

### 字段选择速查

| 需求 | 推荐 | 避免 |
| --- | --- | --- |
| yes/no | `bool` | `scalar` |
| 有边界数字 | `int[...]`、`float[...]` | 无边界 `scalar` |
| 本地化键 | `localisation` | `scalar` |
| `text:KEY` | `prefix_field[localisation]` | `scalar` |
| sprite id | `<sprite>` | `scalar` |
| `background:GFX_x` | `prefix_field[<sprite>]` | `scalar` |
| 定义引用 | `<type>` | `enum[...]` 或 `scalar` |
| 固定值集合 | `enum[name]` | 大量无关字面量 |
| 任意作用域链 | `scope_field` | `scalar` |
| 特定作用域引用 | `scope[type]` | 过宽时避免 `scope_field` |
| 文件路径 | `filepath[...]` | `scalar` |
| 颜色 | `colour_field` / `color_field` | 手写重复 float 规则 |
| effect/trigger 列表 | `alias_name[...] = alias_match_left[...]` | 在每个块复制所有 alias |

### 实现检查清单

新增字段表达式或改变字段语义时，检查：

| 文件 | 原因 |
| --- | --- |
| `RulesTypes.fs` | 是否需要新的 `NewField` union case。 |
| `RulesParser.fs` | `processKey`、规则解析和规则一致性。 |
| `FieldValidators.fs` | 校验和非空校验。 |
| `InfoService.fs` | 引用提取、悬浮和跳转定义。 |
| `CompletionService.fs` | LHS/RHS/裸值补全。 |
| `submodules/cwtools-stellaris-config/config/` | 使用新表达式的规则数据。 |
