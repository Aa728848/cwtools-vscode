# CWT Rule Configuration Guide / CWT 规则配置开发指南

[English](#english) | [中文](#zh-cn) | [Contribution Guide / 贡献指南](../CONTRIBUTING.md) | [Architecture / 架构文档](../ARCHITECTURE.md)

This document is the project guide for the CWT rule language and for authoring
Paradox rule configuration consumed by this extension, the CWTools server, and
the bundled read-only MCP server.

本文档是本项目的 CWT 规则语言与 Paradox 规则配置开发指南，覆盖本扩展、
CWTools 服务端以及随插件分发的只读 MCP 服务所消费的规则配置。

<a id="english"></a>

## English

### Scope And Source Of Truth

CWT is the schema/configuration language used by CWTools to describe how
Paradox script, localisation, assets, and related resources should be parsed,
indexed, validated, completed, and linked.

This guide has two goals:

- Explain the CWT rule model well enough for contributors to author new rules,
  not only patch existing Stellaris files.
- Describe how this repository stores, verifies, packages, and distributes its
  Stellaris CWT rules.
- List the supported authoring surfaces for both Legacy/Clausewitz-style games
  and Jomini-style games.

The source of truth for supported behavior is the CWTools parser and the CWT
rules loaded by this repository. Other tools may use similar-looking rule files;
do not assume their extensions are available here unless the server consumes
them.

### What CWT Rules Model

CWT does not describe game runtime behavior directly. It describes the editor
and language-server model around game files:

- Which folders are scanned and what kind of definitions they contain.
- How a top-level script block becomes a typed definition such as `building`,
  `event`, `technology`, `ship_size`, or `resource`.
- Which keys and values are valid inside each block.
- How many times a key may appear.
- Which values are references to definitions, enums, dynamic values, files,
  localisation keys, scopes, or aliases.
- How scopes flow through nested effects, triggers, links, events, and
  localisation commands.
- Which localisation and image resources are expected for a definition.

These rules power diagnostics, completion, hover, go-to-definition,
find-references, document symbols, dependency graphs, previews, AI tools, and
the bundled MCP server.

### Supported Game Families

The extension and server support both legacy CWTools game models and modern
Jomini game models. The CWT rule language is shared, but generated metadata,
localisation handling, and scope data differ by family.

| Family | Games in this project | Rule authoring notes |
| --- | --- | --- |
| Legacy/Clausewitz-style | Stellaris, Hearts of Iron IV, Europa Universalis IV, Crusader Kings II, Victoria II | Use the shared CWT rules plus legacy localisation command/link rules from `localisation.cwt`. Some games also consume setup or documentation logs for effects, triggers, and modifiers. |
| Jomini-style | Imperator: Rome, Crusader Kings III, Victoria 3, Europa Universalis V, Custom | Use the shared CWT rules plus Jomini metadata from `effects.log`, `triggers.log`, and `data_types.log` where available. Localisation command validation is data-type aware, scopes are more strongly typed, and game data usually lives under a `game/` subdirectory. |

Shared CWT support applies to both families unless a row below explicitly says
otherwise. When writing rules for a non-Stellaris profile, use that game's rule
repository and vanilla files as the concrete source of examples.

### Repository Rule Sources And Packaging

The editable Stellaris rule source is:

```text
submodules/cwtools-stellaris-config/config/
```

Important consumers and generated outputs:

| Path | Role |
| --- | --- |
| `src/Main/` | Loads CWT through the CWTools F# stack and exposes LSP features. |
| `packages/cwtools-shared/` | Host-independent shared MCP core, including generated tool schema and rules safety. |
| `packages/cwtools-mcp/` | Stdio/HTTP MCP server that reuses the same server/rules for external agents. |
| `tools/rules-sync/` | Compares game `script_documentation`, vanilla `common/`, and the CWT baseline. |
| `release/rules/stellaris-rules.zip` | Fallback rule bundle generated from the submodule by packaging scripts. |

Do not edit `release/rules/stellaris-rules.zip` directly. Edit the submodule
rules, then regenerate/package. When changing the submodule, commit inside
`submodules/cwtools-stellaris-config/` first, then commit the updated submodule
pointer in the root repository.

Rules can also be loaded from installed/cached extension storage or an explicit
rules directory. The development source remains the submodule `config/`
directory, and the packaged zip is only a generated fallback.

### File Layout And Rule Categories

Common entry points:

| File or folder | Purpose |
| --- | --- |
| `folders.cwt` | Known game folders to scan or classify. |
| `scopes.cwt` | Scope names and aliases. |
| `links.cwt` | Scope links such as `owner`, `planet`, `solar_system`. |
| `effects.cwt` / `triggers.cwt` | Built-in and scripted effect/trigger aliases. |
| `enums.cwt` | Shared enum and complex enum definitions. |
| `localisation.cwt` | Localisation commands, links, and related aliases. |
| `modifier*.cwt` | Modifier names, categories, and modifier-rule shapes. |
| `effects.log`, `triggers.log`, `data_types.log` | Jomini-generated effect/trigger/localisation data when present. |
| `settings.cwt` | Optional feature settings such as list-merge optimisations. |
| `common/**/*.cwt` | Rules for `common/` definitions such as buildings, jobs, technologies, events, and resources. |
| `gfx/**/*.cwt`, `interface/**/*.cwt`, `sound/**/*.cwt` | Asset, graphics, GUI, sound, and media rules. |

The main CWT categories are:

| Category | Main shape | Describes |
| --- | --- | --- |
| Folder list | `folders.cwt` plain entries | Which game folders are known. |
| Type rules | `types = { type[name] = { ... } }` | How definitions are discovered from files. |
| Subtypes | `subtype[name] = { ... }` | Conditional refinement of a type. |
| Declaration rules | `key = value` or `key = { ... }` | Valid keys and values in script blocks. |
| Aliases | `alias[group:name] = ...` | Reusable commands or block shapes. |
| Enums | `enum[name] = { ... }` | Static value sets. |
| Complex enums | `complex_enum[name] = { ... }` | Value sets derived from game files. |
| Dynamic values | `values = { value[name] = { ... } }` | Predeclared dynamic value sets. |
| Scopes | `scopes = { ... }` | Context names and aliases. |
| Scope groups | `scope_groups = { ... }` | Named reusable scope sets for `scope_group[...]`. |
| Links | `links = { ... }` | Scope transitions. |
| Localisation | `localisation_commands`, `localisation_links` | Localisation command/link scope behavior. |
| Modifiers | `modifier_categories`, modifier aliases | Modifier names and allowed scopes. |
| Resources | `localisation`, `images` in type rules | Expected display text and image assets. |
| Extended metadata | `priorities`, `system_scopes`, `locales`, `database_object_types`, `on_actions` | Jomini/modern metadata used by language features and validations. |

Keep related rules near the game folder they describe. Prefer extending an
existing focused `.cwt` file over creating a broad catch-all file.

### Authoring Support Matrix

This project currently supports these CWT authoring surfaces:

| Area | Supported constructs | Applies to |
| --- | --- | --- |
| File discovery | `folders.cwt`, `type[...]`, `path`, `path_strict`, `path_file`, `path_extension`, `starts_with`, `name_field`, `type_per_file`, `skip_root_key` | Both |
| Type filtering | `## type_key_filter`, `## type_key_regex`, `type_key_prefix`, `root_completion = subtypes`, `error_unknown_keys = yes|suggest`, `obsolete_keys`, `unique`, `severity`, `should_be_used = yes|unless_subtyped` | Both |
| Subtypes | `subtype[name]`, `subtype[!name]`, subtype-local `## type_key_filter`, `## type_key_regex`, `## starts_with`, `## only_if_not`, `## display_name`, `## abbreviation`, `## push_scope` | Both |
| Rule shapes | Leaf rules, node rules, leaf-value rules, value-clause rules, repeated alternatives, `==` comparison rules | Both |
| Rule options | `## cardinality`, `## scope`, `## push_scope`, `## replace_scope`, `## severity`, `## completion_type`, `## error_if_only_match`, `## file_extensions`, `## color_type`, `## type_prefix_from`, `## type_suffix_pattern(s)`, `## inject`, incoming/outgoing reference labels | Both |
| Reuse | `alias[group:name]`, `alias_name[group]`, `alias_match_left[group]`, `single_alias[name]`, `single_alias_right[name]`, `clause_single_alias[...]`, `alias_keys_field[...]`, `alias_params_field[...]` | Both |
| Values and references | `enum[...]`, `complex_enum[...]`, `values`, `value[...]`, `value_set[...]`, `dynamic_value[...]`, `<type>`, prefixed/suffixed `<type>` references | Both |
| Scopes | `scopes`, `aliases`, `is_subscope_of`, `data_type_name`, `scope_groups`, `scope[...]`, `scope_field`, `scope_group[...]`, `event_target[...]`, `links` | Both |
| Link metadata | `input_scope(s)`, `output_scope`, `type = scope|value|both`, `data_source`, `from_data`, `from_argument`, `prefix`, `argument_separator`, `for_definition_type`, `desc` | Both; most important for Jomini dynamic links |
| Localisation | Legacy `localisation_commands` and `localisation_links`; Jomini `data_types.log` functions/data types/promotes; `localisation`, `localisation_synced`, `localisation_inline`, `$localisation_parameter` | Legacy and Jomini differ |
| Modifiers | `modifier_categories`, `supported_scopes`, `internal_id`, `modifiers.cwt`, type-level `modifiers`, modifier aliases, generated modifier rules | Both |
| Generated metadata | `effects.log`, `triggers.log`, `data_types.log`, `settings.cwt` list-merge optimisations | Mostly Jomini; some legacy games use game-specific generated logs |
| Modern metadata | `priorities`, `system_scopes`, `locales`, `database_object_types`, `on_actions` | Jomini/modern profiles |
| Assets and special fields | `filepath[...]`, `filename[...]`, `abs_filepath`, `icon[...]`, `colour[...]`/`color[...]`, `$shader_effect`, `$mesh_locator`, `$technology_with_level`, `name_format[...]`, `stellaris_name_format[...]`, `portrait_dna_field`, `portrait_properties_field`, `ir_country_tag_field`, `ir_family_name_field`, Jomini GUI-prefixed nodes | Game-specific |
| Parameters and dynamic script | `$parameter`, `$parameter_value`, `$script_value_reference`, `$define_reference`, `$array_define_reference`, `$database_object`, `$tags[...]`, `$tags_condition[...]` | Both; Jomini profiles use more of these |

If a construct is parsed but no current game config uses it, prefer adding a
small rule/parser test before relying on it broadly.

### Core Syntax

CWT uses Paradox-like key/value and block syntax:

```cwt
key = value
key = {
    nested = value
}
```

Keys and values may be bare identifiers or quoted strings when spaces or
special characters are needed:

```cwt
"Pop Group" = {
    aliases = { pop_group }
}
```

Duplicate keys are meaningful and commonly represent alternatives. Do not
deduplicate them mechanically:

```cwt
id = <event.ship>
id = <event.scopeless>
days = int
days = value_field
```

Comments have separate meanings:

```cwt
# ordinary comment
### Quick documentation shown to users
## cardinality = 0..1
## push_scope = planet
```

| Prefix | Meaning |
| --- | --- |
| `#` | Ordinary maintainer comment. |
| `###` | Documentation text attached to the next rule. |
| `##` | Rule option attached to the next rule. Keep it directly adjacent. |

Common option comments:

| Option | Use |
| --- | --- |
| `## cardinality = min..max` | Allowed count. `inf` means unbounded. |
| `## push_scope = scope` | Enter a scope while matching a nested block. |
| `## replace_scope = { this = planet root = country }` | Override scope symbols for nested matching. |
| `## scope = any` | Accept broad input scope for one rule. |
| `## severity = warning` | Tune diagnostic severity. |
| `## required` | Mark localisation/image metadata as required. |
| `## primary` | Mark the primary display/resource entry. |
| `## display_name` / `## abbreviation` | User-facing subtype metadata. |
| `## graph_related_types` | Related type list for dependency graphs. |
| `## root_completion = subtypes` | Use subtype keys for root completion. |
| `## only_if_not = name` | Exclude a subtype when another subtype matched. |
| `## type_prefix_from = field` | Build a type reference prefix from a sibling field. |
| `## type_suffix_pattern(s)` | Accepted suffix pattern(s) for type references. |
| `## file_extensions = { dds tga }` | Limit file/resource completion by extension. |
| `## color_type = rgb|hsv|...` | Attach color metadata to a field. |
| `## inject = file.cwt@path/*` | Inject rules from another config location. |
| `## outgoingReferenceLabel` / `## incomingReferenceLabel` | Label graph/reference edges. |

### Data Expression Reference

CWT values are usually data expressions. Supported expressions include:

| Expression | Meaning |
| --- | --- |
| `$any`, `scalar`, `wildcard_scalar` | Any scalar-like value. |
| `yes`, `no`, `bool` | Boolean-style values. |
| `int`, `int[min..max]`, `float`, `float[min..max]` | Numeric values with optional ranges. |
| `percentage_field`, `int_percentage_field` | Percent values. |
| `date_field`, `datetime_field` | Date/datetime values. |
| `value_field`, `int_value_field` | Script-value-aware numeric values. |
| `variable_field`, `int_variable_field`, `*_32` variants | Variable-or-number values, optionally 32-bit. |
| `localisation`, `localisation_synced`, `localisation_inline` | Localisation keys or inline/synced localisation values. |
| `filepath`, `filepath[folder,ext]` | File path-like values, optionally constrained. |
| `filename`, `filename[folder]` | File name values. |
| `abs_filepath`, `absolute_filepath` | Absolute paths. |
| `icon[path]` / `icon` | Icon or resource reference pattern used by nearby rules. |
| `<building>` | Reference to any definition of a type. |
| `<event.ship>` | Reference to a subtype. |
| `prefix_<type>_suffix` | Complex type reference with literal prefix/suffix. |
| `enum[name]` | Static enum value. |
| `value[name]` | Previously set dynamic value such as a flag or variable. |
| `value_set[name]` | Dynamic value declaration such as setting a flag. |
| `dynamic_value[name]` | Dynamic value source, often used by data links. |
| `scope[name]` | Explicit scope reference. |
| `event_target[name]` | Event-target-like scoped reference. |
| `scope_field` | Scope expression field. |
| `scope_group[name]` | Scope group accepted by an effect/trigger. |
| `alias_name[group] = alias_match_left[group]` | Include every alias in a group. |
| `single_alias_right[name]` | Expand a `single_alias` on the right side. |
| `alias_keys_field[name]` | Complete from keys produced by an alias group. |
| `alias_params_field[name,field]` | Resolve parameters from a sibling alias selector. |
| `name_format[name]`, `stellaris_name_format[name]` | Game-specific name format validators. |
| `colour[...]`, `color[...]`, `colour_field`, `color_field` | Color fields and markers. |
| `glob:pattern`, `glob.i:pattern`, `ant:pattern`, `re:pattern` | Pattern fields, with `.i` meaning case-insensitive. |
| `$command` | Command field. |
| `$script_value_reference` | Reference to script/scripted values. |
| `$define_reference`, `$array_define_reference` | Define references. |
| `$database_object` | Jomini database object reference. |
| `$tags[name]`, `$tags_condition[name]` | Tag value references. |
| `$shader_effect`, `$mesh_locator`, `$technology_with_level` | Game-specific asset/script helpers. |
| `$parameter`, `$parameter_value`, `$localisation_parameter` | Script/localisation parameter helpers. |
| `portrait_dna_field`, `portrait_properties_field` | CK2 portrait helpers. |
| `ir_country_tag_field`, `ir_family_name_field` | Imperator helpers. |
| `ignore_field` | Ignore marker for intentionally unconstrained fields. |

Choose the narrowest expression that models the game data. Prefer
`enum[...]`, `<type>`, `value[...]`, or `scope_group[...]` over free-form
`scalar` when the target set is knowable.

### Types And Subtypes

`types = { ... }` maps game files to definition types. This is what makes a
script block discoverable by name.

```cwt
types = {
    type[building] = {
        path = "game/common/buildings"

        subtype[corporate] = {
            owner_type = corporate
        }

        localisation = {
            ## required
            Name = "$"
            ## required
            Description = "$_desc"
        }
    }
}
```

Use type rules when adding a new definition family or changing how an existing
definition is discovered.

Common fields and options:

| Field or option | Use |
| --- | --- |
| `path` | Game-relative folder path, usually under `game/...`. |
| `path_strict` | Keep path matching strict instead of broad folder matching. |
| `path_file` | Specific file name. |
| `path_extension` | Extension filter. |
| `name_field` | Property that contains the definition ID, such as `id`. |
| `name_from_file` | Use the file name as the definition name. |
| `type_per_file` | Treat a file as one definition instance. |
| `skip_root_key` | Ignore wrapper/root keys before matching definitions. |
| `type_key_prefix` | Prefix applied to discovered type keys. |
| `unique` / `severity` | Duplicate-name diagnostic behavior. |
| `should_be_used` | Require definitions to be referenced (`yes` or `unless_subtyped`). |
| `error_unknown_keys` | Report or suggest unknown root keys (`yes` or `suggest`). |
| `obsolete_keys` | Map obsolete keys to migration messages. |
| `## type_key_filter` | Restrict matching to specific top-level keys. |
| `## type_key_regex` | Restrict matching by regular expression. |
| `## starts_with` | Restrict matching by prefix. |
| `## push_scope` | Scope pushed when the type/subtype matches. |

Subtypes refine a type by checking fields or structure. Put more specific
subtypes before broader fallback subtypes. Type rules discover definitions;
declaration rules validate their bodies. A new type often needs both.

### Declaration Rules

Declaration rules describe the shape of script blocks:

```cwt
## push_scope = planet
building = {
    ## cardinality = 0..1
    base_buildtime = int

    ## cardinality = 0..inf
    category = enum[building_categories]

    ## cardinality = 0..1
    potential = {
        alias_name[trigger] = alias_match_left[trigger]
    }
}
```

Use declaration rules when adding or changing allowed properties inside a game
definition block. Nesting mirrors the expected script shape. Keep repeated
alternatives explicit, because the server uses them to match different legal
forms.

When adding a declaration:

1. Find a nearby rule for the same game folder or feature.
2. Copy the local style for indentation, comments, cardinality, and scopes.
3. Use a precise value expression.
4. Add `###` documentation if it improves completion/hover.
5. Avoid wide `any`/`scalar` unless the game data is genuinely unconstrained.

### Aliases

Aliases define reusable effect, trigger, modifier, pre-trigger, or helper
shapes. They are ideal for commands that can appear in many contexts.

```cwt
###Creates a starbase in orbit of the star of the scoped galactic object
alias[effect:create_starbase] = {
    ## cardinality = 0..1
    owner = scope_group[target_country]
    ## cardinality = 1..1
    size = <ship_size.starbase>
    ## cardinality = 0..1
    ## push_scope = starbase
    effect = {
        alias_name[effect] = alias_match_left[effect]
    }
}
```

Alias groups such as `effect`, `trigger`, `modifier`, and `modifier_rule` are
reused through `alias_name[...] = alias_match_left[...]`. This is how recursive
blocks such as `if`, `else_if`, `hidden_effect`, and nested effect blocks stay
compact.

Use duplicate alias declarations when a command accepts multiple forms:

```cwt
alias[effect:change_government] = random
alias[effect:change_government] = <authority>
alias[effect:change_government] = {
    authority = <authority>
}
```

### Enums And Complex Enums

Static enums list explicit values:

```cwt
enums = {
    enum[building_owner_type] = {
        normal
        corporate
        subject_holding
    }
}
```

Use static enums for small, stable sets whose values are not definitions in game
files.

Complex enums derive values from game files:

```cwt
enums = {
    complex_enum[building_sets] = {
        path = "game/common/buildings"
        name = {
            building_sets = {
                enum_name
            }
        }
    }
}
```

Use complex enums when values come from vanilla/mod data and need to stay in
sync with the workspace. A complex enum should point at the folder and field
where the values are actually declared.

### Scopes And Links

Scopes define context types and aliases:

```cwt
scopes = {
    Country = {
        aliases = { country }
    }
    Planet = {
        aliases = { planet }
    }
}
```

Scopes may also declare inheritance-like relationships and Jomini data type
names:

```cwt
scopes = {
    Character = {
        aliases = { character }
        is_subscope_of = { actor }
        data_type_name = character
    }
}

scope_groups = {
    target_country = { country owner_country }
}
```

Links define transitions between scopes:

```cwt
links = {
    owner = {
        input_scopes = { planet ship fleet country }
        output_scope = Country
    }
}
```

Links can also be data-driven:

```cwt
links = {
    saved_scope = {
        input_scopes = { country character }
        output_scope = character
        type = scope
        data_source = value[event_target]
        prefix = event_target:
    }
}
```

Scope rules are what make references such as `owner`, `solar_system`,
`last_created_country`, event targets, localisation commands, effects, and
triggers context-aware.

When adding or changing scope behavior:

- Add the scope name and aliases in `scopes.cwt` when the context is new.
- Add `scope_groups` when several scopes are accepted by many rules.
- Add links in `links.cwt` when script can navigate from one scope to another.
- Use data links for Jomini-style saved scopes, database objects, tag values, or
  argument-based links.
- Update effect/trigger aliases when a command pushes or replaces scope.
- Keep aliases consistent: both display names (`Country`) and lower-case script
  aliases (`country`) appear in existing rules.

Missing links often cause otherwise valid scripted references to fail scope
checking.

### Localisation, Images, And Display Resources

Type rules can declare required localisation and image resources:

```cwt
types = {
    type[building] = {
        localisation = {
            ## required
            Name = "$"
            ## required
            Description = "$_desc"
        }
        images = {
            icon = icon
        }
    }
}
```

`$` is the current definition name placeholder. Derived names such as `$_desc`
are common for description keys.

Legacy localisation uses `localisation.cwt` to model command/link scope
behavior inside localisation strings:

```cwt
localisation_commands = {
    GetName = any
    GetFleetName = { fleet ship starbase }
}

localisation_links = {
    owner = country
}
```

Jomini localisation additionally consumes `data_types.log` when present. That
metadata drives function/data-type validation, command confidence, and
promotion rules for localisation command chains. For Jomini games, keep
`data_types.log` in sync with the game-generated metadata and use
`localisation.cwt` only for rule-side additions that are still needed.

Update localisation rules when a game patch adds text commands, link-like
constructs, data types, function signatures, or new expected localisation keys
on definitions.

### Generated And Extended Metadata

Some authoring support comes from generated metadata files rather than ordinary
hand-written declaration rules:

| File/block | Purpose |
| --- | --- |
| `effects.log` | Jomini effect definitions generated by the game. |
| `triggers.log` | Jomini trigger definitions generated by the game. |
| `data_types.log` | Jomini localisation/data type definitions. |
| `trigger_docs.log` | Stellaris-style generated trigger/effect documentation where used. |
| `setup.log`, `modifiers.log`, `modifiers.cwt` | Modifier extraction depending on the game profile. |
| `settings.cwt` / `list_merge_optimisations` | Feature settings such as HOI4 list merge optimisation. |
| `priorities` | Config priority/merge strategy metadata. |
| `system_scopes` | Named system scopes with optional `base_id`, display name, and description. |
| `locales` | Locale IDs, codes, and support flags. |
| `database_object_types` | Jomini database object type metadata. |
| `on_actions` | On-action event type metadata, hints, and scope replacement. |

Treat generated logs as inputs to the rule loader. Do not manually copy large
generated sections into CWT declaration files unless the rule-sync/review flow
calls for it.

### Modifiers

Modifier rules describe names, groups, and supported scopes. In this repository,
modifier categories look like:

```cwt
modifier_categories = {
    Planets = {
        supported_scopes = { planet leader galacticobject country }
    }
    Countries = {
        supported_scopes = { country }
    }
}
```

When adding modifiers:

- Prefer existing modifier files and categories.
- Keep supported scopes aligned with game behavior.
- Use modifier aliases/rules when a block accepts arbitrary modifier entries.
- Verify with a real sample file because modifier diagnostics are scope-heavy.

### Authoring Recipes

Add a new definition type:

1. Confirm the game folder and file pattern.
2. Add a `type[...]` rule with `path`, `path_file`, `path_extension`, or
   `name_field` as needed.
3. Add subtype rules if the definition has meaningful conditional variants.
4. Add declaration rules for the block body.
5. Add localisation/images metadata if the type is user-facing.
6. Add enum/complex enum references where other rules should point to it.

Add a new effect or trigger:

1. Choose the correct alias group: usually `effect` or `trigger`.
2. Model every legal value form with duplicate alias declarations.
3. Add `## push_scope` or `## replace_scope` for nested script blocks.
4. Reuse `alias_name[effect]`, `alias_name[trigger]`, and `scope_group[...]`
   rather than expanding all nested possibilities by hand.

Add an enum:

1. Use `enum[...]` for stable literal values.
2. Use `complex_enum[...]` for values derived from game files.
3. Replace free-form `scalar` usages with the enum where the rule can be made
   precise.

Add a scope link:

1. Add any missing scope/alias in `scopes.cwt`.
2. Add a `links.cwt` entry with accurate `input_scopes` and `output_scope`.
3. Update aliases that expose the link in effects, triggers, or localisation.
4. Test a valid and invalid sample to confirm diagnostics changed as expected.

### Verification Checklist

Run targeted checks after rule edits:

```bash
npm run rules:stellaris:report -- --no-open
dotnet build src/Main/
npm run build:docs
npm run check:release -- --skip-compile --skip-test
```

For MCP-facing semantic behavior, also run:

```bash
npm run build:shared
npm run build:mcp
npm run test:contracts
```

Before merging:

- Test in an Extension Development Host with a small sample mod.
- Inspect new diagnostics, completion, hover, references, and localisation
  behavior.
- If a generated rules-sync report was used, review it before copying any output
  into stable CWT files.
- Commit submodule changes inside `submodules/cwtools-stellaris-config/`, then
  commit the root submodule pointer.

### Pitfalls

- Do not flatten duplicate keys; alternatives are often represented by repeated
  declarations.
- Keep `##` options immediately above the rule they configure.
- Use forward slashes in paths.
- Avoid broad `any`, `all`, and `scalar` unless neighboring rules show that the
  game data is genuinely unconstrained.
- Prefer `enum[...]`, `<type>`, `value[...]`, and `scope_group[...]` when the
  target set is knowable.
- Do not hand-edit generated fallback zips.
- Do not assume rule categories or options from other tools are supported here
  unless the CWTools server actually consumes them.

<a id="zh-cn"></a>

## 中文

### 范围与事实源

CWT 是 CWTools 用来描述 Paradox 脚本、本地化、资产和相关资源的
schema / 配置语言。它决定这些文件如何被解析、索引、校验、补全和链接。

本文档有两个目标：

- 说明 CWT 规则模型，使贡献者可以编写新规则，而不只是修补现有 Stellaris
  规则文件。
- 说明本仓库如何保存、校验、打包和分发 Stellaris CWT 规则。
- 列出 Legacy/Clausewitz 风格游戏与 Jomini 风格游戏都支持的规则编写入口。

支持行为的事实源是 CWTools 解析器以及本仓库实际加载的 CWT 规则。其他工具
可能使用外观相似的规则文件；除非本项目服务端实际消费对应语法，否则不要假设
那些扩展在这里可用。

### CWT 规则描述什么

CWT 不直接描述游戏运行时行为，而是描述围绕游戏文件建立的编辑器和语言服务模型：

- 哪些目录会被扫描，以及这些目录包含什么类型的定义。
- 顶级脚本块如何成为 `building`、`event`、`technology`、`ship_size`、
  `resource` 等带类型的定义。
- 每个块内允许哪些键和值。
- 某个键允许出现多少次。
- 哪些值是定义引用、枚举、动态值、文件、本地化键、作用域或别名。
- 作用域如何在嵌套 effect、trigger、link、事件和本地化命令中流动。
- 一个定义应具备哪些本地化和图片资源。

这些规则支撑诊断、补全、悬停、跳转定义、查找引用、文档符号、依赖图、
预览、AI 工具以及随插件分发的 MCP 服务。

### 支持的游戏族

扩展与服务端同时支持传统 CWTools 游戏模型和现代 Jomini 游戏模型。CWT 规则语言
是共享的，但生成式元数据、本地化处理和作用域数据会因游戏族不同而变化。

| 游戏族 | 本项目中的游戏 | 规则编写说明 |
| --- | --- | --- |
| Legacy/Clausewitz 风格 | Stellaris、Hearts of Iron IV、Europa Universalis IV、Crusader Kings II、Victoria II | 使用共享 CWT 规则，并通过 `localisation.cwt` 描述 legacy 本地化命令/链接。部分游戏还会消费 setup 或 documentation 日志以获得 effect、trigger 和 modifier 数据。 |
| Jomini 风格 | Imperator: Rome、Crusader Kings III、Victoria 3、Europa Universalis V、Custom | 使用共享 CWT 规则，并在可用时消费 `effects.log`、`triggers.log`、`data_types.log` 等 Jomini 元数据。本地化命令校验具备 data type 感知，作用域更强类型化，游戏数据通常位于 `game/` 子目录下。 |

除非下方表格明确说明差异，共享 CWT 支持同时适用于两类游戏。为非 Stellaris
profile 编写规则时，应以对应游戏的规则仓库和原版文件作为具体示例来源。

### 仓库规则来源与打包

可编辑的 Stellaris 规则来源是：

```text
submodules/cwtools-stellaris-config/config/
```

重要消费者与生成物：

| 路径 | 作用 |
| --- | --- |
| `src/Main/` | 通过 CWTools F# 栈加载 CWT，并暴露 LSP 能力。 |
| `packages/cwtools-shared/` | 无宿主依赖的 MCP 共享核心，包含生成式工具 schema 和规则安全逻辑。 |
| `packages/cwtools-mcp/` | 复用同一服务端/规则的 stdio/HTTP MCP 服务。 |
| `tools/rules-sync/` | 对比游戏 `script_documentation`、原版 `common/` 与 CWT 基线。 |
| `release/rules/stellaris-rules.zip` | 由打包脚本从子模块生成的 fallback 规则包。 |

不要直接编辑 `release/rules/stellaris-rules.zip`。应修改子模块中的规则，再
重新生成/打包。修改子模块时，先在 `submodules/cwtools-stellaris-config/`
内部提交，再回到根仓库提交更新后的 submodule 指针。

规则也可能从已安装/缓存的扩展存储或显式指定的规则目录加载。开发事实源仍是
子模块的 `config/` 目录，打包得到的 zip 只是生成式 fallback。

### 文件组织与规则分类

常见入口：

| 文件或目录 | 作用 |
| --- | --- |
| `folders.cwt` | 已知游戏目录，用于扫描或分类。 |
| `scopes.cwt` | 作用域名称与别名。 |
| `links.cwt` | `owner`、`planet`、`solar_system` 等作用域链接。 |
| `effects.cwt` / `triggers.cwt` | 内置和脚本化 effect/trigger 别名。 |
| `enums.cwt` | 共享枚举与复杂枚举定义。 |
| `localisation.cwt` | 本地化命令、链接和相关别名。 |
| `modifier*.cwt` | 修正名、分类和修正规则结构。 |
| `effects.log`、`triggers.log`、`data_types.log` | 存在时作为 Jomini 生成式 effect/trigger/本地化数据。 |
| `settings.cwt` | 可选功能设置，如 list-merge 优化。 |
| `common/**/*.cwt` | `common/` 下建筑、岗位、科技、事件、资源等定义的规则。 |
| `gfx/**/*.cwt`、`interface/**/*.cwt`、`sound/**/*.cwt` | 资产、图形、GUI、声音和媒体规则。 |

主要 CWT 分类：

| 分类 | 主要形态 | 描述内容 |
| --- | --- | --- |
| 目录列表 | `folders.cwt` 普通条目 | 哪些游戏目录已知。 |
| 类型规则 | `types = { type[name] = { ... } }` | 如何从文件发现定义。 |
| 子类型 | `subtype[name] = { ... }` | 对类型做条件化细分。 |
| 声明规则 | `key = value` 或 `key = { ... }` | 脚本块内合法的键和值。 |
| 别名 | `alias[group:name] = ...` | 可复用命令或块结构。 |
| 枚举 | `enum[name] = { ... }` | 静态值集合。 |
| 复杂枚举 | `complex_enum[name] = { ... }` | 从游戏文件派生的值集合。 |
| 动态值 | `values = { value[name] = { ... } }` | 预声明动态值集合。 |
| 作用域 | `scopes = { ... }` | 上下文名称与别名。 |
| 作用域组 | `scope_groups = { ... }` | 供 `scope_group[...]` 复用的命名作用域集合。 |
| 链接 | `links = { ... }` | 作用域转换。 |
| 本地化 | `localisation_commands`、`localisation_links` | 本地化命令/链接的作用域行为。 |
| 修正 | `modifier_categories`、modifier 别名 | 修正名与允许作用域。 |
| 资源 | 类型规则中的 `localisation`、`images` | 期望的展示文本与图片资产。 |
| 扩展元数据 | `priorities`、`system_scopes`、`locales`、`database_object_types`、`on_actions` | Jomini/现代 profile 使用的语言功能与校验元数据。 |

规则应放在最接近其描述对象的文件中。优先扩展已有的聚焦 `.cwt` 文件，而不是
新建宽泛的万能文件。

### 编写支持矩阵

本项目当前支持这些 CWT 编写入口：

| 领域 | 支持构造 | 适用范围 |
| --- | --- | --- |
| 文件发现 | `folders.cwt`、`type[...]`、`path`、`path_strict`、`path_file`、`path_extension`、`starts_with`、`name_field`、`type_per_file`、`skip_root_key` | 两者 |
| 类型过滤 | `## type_key_filter`、`## type_key_regex`、`type_key_prefix`、`root_completion = subtypes`、`error_unknown_keys = yes|suggest`、`obsolete_keys`、`unique`、`severity`、`should_be_used = yes|unless_subtyped` | 两者 |
| 子类型 | `subtype[name]`、`subtype[!name]`、子类型局部 `## type_key_filter`、`## type_key_regex`、`## starts_with`、`## only_if_not`、`## display_name`、`## abbreviation`、`## push_scope` | 两者 |
| 规则形态 | 叶子规则、节点规则、叶值规则、value-clause 规则、重复替代、`==` 比较规则 | 两者 |
| 规则选项 | `## cardinality`、`## scope`、`## push_scope`、`## replace_scope`、`## severity`、`## completion_type`、`## error_if_only_match`、`## file_extensions`、`## color_type`、`## type_prefix_from`、`## type_suffix_pattern(s)`、`## inject`、incoming/outgoing reference labels | 两者 |
| 复用 | `alias[group:name]`、`alias_name[group]`、`alias_match_left[group]`、`single_alias[name]`、`single_alias_right[name]`、`clause_single_alias[...]`、`alias_keys_field[...]`、`alias_params_field[...]` | 两者 |
| 值与引用 | `enum[...]`、`complex_enum[...]`、`values`、`value[...]`、`value_set[...]`、`dynamic_value[...]`、`<type>`、带前后缀的 `<type>` 引用 | 两者 |
| 作用域 | `scopes`、`aliases`、`is_subscope_of`、`data_type_name`、`scope_groups`、`scope[...]`、`scope_field`、`scope_group[...]`、`event_target[...]`、`links` | 两者 |
| 链接元数据 | `input_scope(s)`、`output_scope`、`type = scope|value|both`、`data_source`、`from_data`、`from_argument`、`prefix`、`argument_separator`、`for_definition_type`、`desc` | 两者；对 Jomini 动态链接尤其重要 |
| 本地化 | Legacy `localisation_commands` 和 `localisation_links`；Jomini `data_types.log` functions/data types/promotes；`localisation`、`localisation_synced`、`localisation_inline`、`$localisation_parameter` | Legacy 与 Jomini 有差异 |
| 修正 | `modifier_categories`、`supported_scopes`、`internal_id`、`modifiers.cwt`、type 级 `modifiers`、modifier 别名、生成式 modifier 规则 | 两者 |
| 生成式元数据 | `effects.log`、`triggers.log`、`data_types.log`、`settings.cwt` list-merge 优化 | 主要是 Jomini；部分 legacy 游戏也使用游戏特定生成日志 |
| 现代元数据 | `priorities`、`system_scopes`、`locales`、`database_object_types`、`on_actions` | Jomini/现代 profile |
| 资产与特殊字段 | `filepath[...]`、`filename[...]`、`abs_filepath`、`icon[...]`、`colour[...]`/`color[...]`、`$shader_effect`、`$mesh_locator`、`$technology_with_level`、`name_format[...]`、`stellaris_name_format[...]`、`portrait_dna_field`、`portrait_properties_field`、`ir_country_tag_field`、`ir_family_name_field`、Jomini GUI 前缀节点 | 游戏特定 |
| 参数与动态脚本 | `$parameter`、`$parameter_value`、`$script_value_reference`、`$define_reference`、`$array_define_reference`、`$database_object`、`$tags[...]`、`$tags_condition[...]` | 两者；Jomini profile 使用更多 |

如果某个构造已被解析器支持但当前游戏配置很少使用，建议先补小型规则/解析测试，再大范围依赖。

### 核心语法

CWT 使用类似 Paradox 的键值和块语法：

```cwt
key = value
key = {
    nested = value
}
```

当包含空格或特殊字符时，键和值可以使用引号：

```cwt
"Pop Group" = {
    aliases = { pop_group }
}
```

重复键有语义，常用于表达可选替代结构。不要机械去重：

```cwt
id = <event.ship>
id = <event.scopeless>
days = int
days = value_field
```

注释有不同含义：

```cwt
# 普通注释
### 展示给用户的快速文档
## cardinality = 0..1
## push_scope = planet
```

| 前缀 | 含义 |
| --- | --- |
| `#` | 普通维护注释。 |
| `###` | 绑定到下一条规则的文档文本。 |
| `##` | 绑定到下一条规则的选项注释，应紧贴目标规则。 |

常见选项注释：

| 选项 | 用途 |
| --- | --- |
| `## cardinality = min..max` | 允许出现次数，`inf` 表示无限。 |
| `## push_scope = scope` | 匹配嵌套块时进入某个作用域。 |
| `## replace_scope = { this = planet root = country }` | 覆盖嵌套匹配中的作用域符号。 |
| `## scope = any` | 对单条规则接受宽泛输入作用域。 |
| `## severity = warning` | 调整诊断级别。 |
| `## required` | 标记本地化/图片元数据为必需。 |
| `## primary` | 标记主要展示/资源项。 |
| `## display_name` / `## abbreviation` | 面向用户展示的子类型元数据。 |
| `## graph_related_types` | 依赖图相关类型列表。 |
| `## root_completion = subtypes` | 使用子类型键提供根级补全。 |
| `## only_if_not = name` | 当另一子类型已匹配时排除当前子类型。 |
| `## type_prefix_from = field` | 从同级字段构造类型引用前缀。 |
| `## type_suffix_pattern(s)` | 类型引用允许的后缀模式。 |
| `## file_extensions = { dds tga }` | 按扩展名限制文件/资源补全。 |
| `## color_type = rgb|hsv|...` | 为字段附加颜色元数据。 |
| `## inject = file.cwt@path/*` | 从另一配置位置注入规则。 |
| `## outgoingReferenceLabel` / `## incomingReferenceLabel` | 标注图/引用边。 |

### 数据表达式参考

CWT 的值通常是数据表达式。支持的表达式包括：

| 表达式 | 含义 |
| --- | --- |
| `$any`、`scalar`、`wildcard_scalar` | 任意标量风格值。 |
| `yes`、`no`、`bool` | 布尔风格值。 |
| `int`、`int[min..max]`、`float`、`float[min..max]` | 数字值，可带范围。 |
| `percentage_field`、`int_percentage_field` | 百分比值。 |
| `date_field`、`datetime_field` | 日期/日期时间值。 |
| `value_field`、`int_value_field` | 可使用 script value 的数值表达式。 |
| `variable_field`、`int_variable_field`、`*_32` 变体 | 变量或数字值，可限制为 32 位。 |
| `localisation`、`localisation_synced`、`localisation_inline` | 本地化键或 inline/synced 本地化值。 |
| `filepath`、`filepath[folder,ext]` | 文件路径风格值，可限制目录/扩展名。 |
| `filename`、`filename[folder]` | 文件名值。 |
| `abs_filepath`、`absolute_filepath` | 绝对路径。 |
| `icon[path]` / `icon` | 邻近规则使用的图标或资源引用模式。 |
| `<building>` | 某个类型的任意定义引用。 |
| `<event.ship>` | 子类型引用。 |
| `prefix_<type>_suffix` | 带字面前后缀的复杂类型引用。 |
| `enum[name]` | 静态枚举值。 |
| `value[name]` | 已设置的动态值，如 flag 或变量。 |
| `value_set[name]` | 动态值声明，如设置 flag。 |
| `dynamic_value[name]` | 动态值来源，常用于 data link。 |
| `scope[name]` | 显式作用域引用。 |
| `event_target[name]` | 类 event target 的作用域引用。 |
| `scope_field` | 作用域表达式字段。 |
| `scope_group[name]` | effect/trigger 接受的作用域组。 |
| `alias_name[group] = alias_match_left[group]` | 引入某个别名组中的所有别名。 |
| `single_alias_right[name]` | 在右侧展开 `single_alias`。 |
| `alias_keys_field[name]` | 从某个别名组产生的键中补全。 |
| `alias_params_field[name,field]` | 从同级 alias selector 解析参数。 |
| `name_format[name]`、`stellaris_name_format[name]` | 游戏特定名称格式校验。 |
| `colour[...]`、`color[...]`、`colour_field`、`color_field` | 颜色字段与标记。 |
| `glob:pattern`、`glob.i:pattern`、`ant:pattern`、`re:pattern` | pattern 字段，`.i` 表示大小写不敏感。 |
| `$command` | 命令字段。 |
| `$script_value_reference` | script/scripted value 引用。 |
| `$define_reference`、`$array_define_reference` | define 引用。 |
| `$database_object` | Jomini database object 引用。 |
| `$tags[name]`、`$tags_condition[name]` | tag 值引用。 |
| `$shader_effect`、`$mesh_locator`、`$technology_with_level` | 游戏特定资产/脚本辅助字段。 |
| `$parameter`、`$parameter_value`、`$localisation_parameter` | 脚本/本地化参数辅助字段。 |
| `portrait_dna_field`、`portrait_properties_field` | CK2 肖像辅助字段。 |
| `ir_country_tag_field`、`ir_family_name_field` | Imperator 辅助字段。 |
| `ignore_field` | 有意不约束字段的忽略标记。 |

应选择能准确表达游戏数据的最窄表达式。当目标集合可知时，优先使用
`enum[...]`、`<type>`、`value[...]` 或 `scope_group[...]`，而不是自由
`scalar`。

### 类型与子类型

`types = { ... }` 把游戏文件映射为定义类型，让脚本块可以被按名称发现：

```cwt
types = {
    type[building] = {
        path = "game/common/buildings"

        subtype[corporate] = {
            owner_type = corporate
        }

        localisation = {
            ## required
            Name = "$"
            ## required
            Description = "$_desc"
        }
    }
}
```

新增定义族或修改已有定义的发现方式时使用类型规则。

常见字段与选项：

| 字段或选项 | 用途 |
| --- | --- |
| `path` | 相对游戏目录路径，通常位于 `game/...` 下。 |
| `path_strict` | 保持严格路径匹配，不做宽泛目录匹配。 |
| `path_file` | 指定文件名。 |
| `path_extension` | 扩展名过滤。 |
| `name_field` | 包含定义 ID 的属性，如 `id`。 |
| `name_from_file` | 从文件名推导定义名。 |
| `type_per_file` | 把一个文件视为一个定义实例。 |
| `skip_root_key` | 匹配定义前跳过包装/root key。 |
| `type_key_prefix` | 为发现的 type key 添加前缀。 |
| `unique` / `severity` | 重名诊断行为。 |
| `should_be_used` | 要求定义被引用（`yes` 或 `unless_subtyped`）。 |
| `error_unknown_keys` | 报告或提示未知 root key（`yes` 或 `suggest`）。 |
| `obsolete_keys` | 把过时键映射到迁移提示。 |
| `## type_key_filter` | 限定顶级键。 |
| `## type_key_regex` | 用正则限定顶级键。 |
| `## starts_with` | 用前缀限定顶级键。 |
| `## push_scope` | 类型或子类型匹配时推入的作用域。 |

子类型通过字段或结构条件细分类型。更具体的子类型应放在更宽泛的 fallback
子类型之前。类型规则负责发现定义；声明规则负责校验定义体。新增类型通常两者都需要。

### 声明规则

声明规则描述脚本块的结构：

```cwt
## push_scope = planet
building = {
    ## cardinality = 0..1
    base_buildtime = int

    ## cardinality = 0..inf
    category = enum[building_categories]

    ## cardinality = 0..1
    potential = {
        alias_name[trigger] = alias_match_left[trigger]
    }
}
```

新增或修改游戏定义块内允许的属性时使用声明规则。嵌套层级应镜像期望的脚本结构。
重复替代形式要显式保留，因为服务端会用它们匹配不同的合法写法。

添加声明时：

1. 找到同一游戏目录或功能附近的规则。
2. 沿用本地缩进、注释、出现次数和作用域风格。
3. 使用精确的数据表达式。
4. 如果能改善补全/悬停体验，添加 `###` 文档。
5. 除非游戏数据确实不受约束，否则避免宽泛的 `any`/`scalar`。

### 别名

别名定义可复用的 effect、trigger、modifier、pre-trigger 或辅助结构。凡是可在
多个上下文出现的命令，都适合用别名表示。

```cwt
###Creates a starbase in orbit of the star of the scoped galactic object
alias[effect:create_starbase] = {
    ## cardinality = 0..1
    owner = scope_group[target_country]
    ## cardinality = 1..1
    size = <ship_size.starbase>
    ## cardinality = 0..1
    ## push_scope = starbase
    effect = {
        alias_name[effect] = alias_match_left[effect]
    }
}
```

`effect`、`trigger`、`modifier`、`modifier_rule` 等别名组通过
`alias_name[...] = alias_match_left[...]` 复用。这让 `if`、`else_if`、
`hidden_effect` 和嵌套 effect 块等递归结构保持紧凑。

当一个命令接受多种形式时，使用重复别名声明：

```cwt
alias[effect:change_government] = random
alias[effect:change_government] = <authority>
alias[effect:change_government] = {
    authority = <authority>
}
```

### 枚举与复杂枚举

静态枚举列出显式值：

```cwt
enums = {
    enum[building_owner_type] = {
        normal
        corporate
        subject_holding
    }
}
```

小型、稳定、且不是游戏文件定义的字面值集合适合使用静态枚举。

复杂枚举从游戏文件中派生值：

```cwt
enums = {
    complex_enum[building_sets] = {
        path = "game/common/buildings"
        name = {
            building_sets = {
                enum_name
            }
        }
    }
}
```

当值来自原版/Mod 数据并需要跟随工作区变化时，使用复杂枚举。复杂枚举应指向
值实际声明所在的目录和字段。

### 作用域与链接

作用域定义上下文类型与别名：

```cwt
scopes = {
    Country = {
        aliases = { country }
    }
    Planet = {
        aliases = { planet }
    }
}
```

作用域也可以声明类似继承的关系和 Jomini data type 名称：

```cwt
scopes = {
    Character = {
        aliases = { character }
        is_subscope_of = { actor }
        data_type_name = character
    }
}

scope_groups = {
    target_country = { country owner_country }
}
```

链接定义作用域之间的转换：

```cwt
links = {
    owner = {
        input_scopes = { planet ship fleet country }
        output_scope = Country
    }
}
```

链接也可以由数据驱动：

```cwt
links = {
    saved_scope = {
        input_scopes = { country character }
        output_scope = character
        type = scope
        data_source = value[event_target]
        prefix = event_target:
    }
}
```

正是这些作用域规则让 `owner`、`solar_system`、`last_created_country`、事件目标、
本地化命令、effect 和 trigger 具备上下文感知。

新增或修改作用域行为时：

- 如果上下文是新的，在 `scopes.cwt` 增加作用域名和别名。
- 当多条规则反复接受同一组作用域时，添加 `scope_groups`。
- 当脚本可以从一个作用域导航到另一个作用域时，在 `links.cwt` 增加链接。
- 对 Jomini 风格的 saved scope、database object、tag 值或基于参数的链接，使用
  data link。
- 当命令会推入或替换作用域时，更新 effect/trigger 别名。
- 保持别名一致：现有规则中同时会出现展示名（如 `Country`）和脚本小写别名
  （如 `country`）。

缺少链接常会导致本应合法的脚本引用无法通过作用域检查。

### 本地化、图片与展示资源

类型规则可以声明必需的本地化和图片资源：

```cwt
types = {
    type[building] = {
        localisation = {
            ## required
            Name = "$"
            ## required
            Description = "$_desc"
        }
        images = {
            icon = icon
        }
    }
}
```

`$` 表示当前定义名占位符。`$_desc` 这类派生名常用于描述文本键。

Legacy 本地化使用 `localisation.cwt` 建模本地化字符串中的命令/链接作用域行为：

```cwt
localisation_commands = {
    GetName = any
    GetFleetName = { fleet ship starbase }
}

localisation_links = {
    owner = country
}
```

Jomini 本地化还会在存在时消费 `data_types.log`。该元数据会驱动本地化命令链的
function/data-type 校验、命令可信度和 promote 规则。为 Jomini 游戏维护规则时，
应让 `data_types.log` 跟随游戏生成的元数据更新；`localisation.cwt` 只补规则侧
仍然需要的内容。

当游戏补丁新增文本命令、类似链接的结构、data type、function signature，或某类
定义新增期望本地化键时，应更新本地化规则。

### 生成式与扩展元数据

部分编写支持来自生成式元数据文件，而不是普通手写声明规则：

| 文件/块 | 作用 |
| --- | --- |
| `effects.log` | 游戏生成的 Jomini effect 定义。 |
| `triggers.log` | 游戏生成的 Jomini trigger 定义。 |
| `data_types.log` | Jomini 本地化/data type 定义。 |
| `trigger_docs.log` | 使用时提供 Stellaris 风格生成式 trigger/effect 文档。 |
| `setup.log`、`modifiers.log`、`modifiers.cwt` | 按游戏 profile 提取 modifier。 |
| `settings.cwt` / `list_merge_optimisations` | HOI4 list merge 优化等功能设置。 |
| `priorities` | 配置优先级/合并策略元数据。 |
| `system_scopes` | 带可选 `base_id`、展示名和说明的系统作用域。 |
| `locales` | 语言 ID、代码和支持标记。 |
| `database_object_types` | Jomini database object 类型元数据。 |
| `on_actions` | on-action event type、hint 和作用域替换元数据。 |

生成式日志应作为规则加载器输入处理。除非规则同步/审查流程明确需要，不要把大段
生成内容手工复制进 CWT 声明文件。

### 修正

Modifier 规则描述修正名、分组与支持的作用域。本仓库中的 modifier 分类示例：

```cwt
modifier_categories = {
    Planets = {
        supported_scopes = { planet leader galacticobject country }
    }
    Countries = {
        supported_scopes = { country }
    }
}
```

添加 modifier 时：

- 优先使用已有 modifier 文件与分类。
- 保持支持作用域与游戏行为一致。
- 当某个块接受任意 modifier 条目时，使用 modifier alias/rule。
- 用真实示例文件验证，因为 modifier 诊断高度依赖作用域。

### 编写配方

添加新的定义类型：

1. 确认游戏目录和文件模式。
2. 按需添加带 `path`、`path_file`、`path_extension` 或 `name_field` 的
   `type[...]` 规则。
3. 如果定义存在有意义的条件变体，添加子类型规则。
4. 为定义体添加声明规则。
5. 如果类型面向用户展示，添加本地化/图片元数据。
6. 在其他规则需要引用它的地方添加 enum/complex enum 引用。

添加新的 effect 或 trigger：

1. 选择正确别名组，通常是 `effect` 或 `trigger`。
2. 用重复别名声明表达所有合法值形式。
3. 为嵌套脚本块添加 `## push_scope` 或 `## replace_scope`。
4. 复用 `alias_name[effect]`、`alias_name[trigger]` 和 `scope_group[...]`，
   不要手写展开所有嵌套可能。

添加枚举：

1. 稳定字面值使用 `enum[...]`。
2. 从游戏文件派生的值使用 `complex_enum[...]`。
3. 当规则可以更精确时，用枚举替换自由 `scalar`。

添加作用域链接：

1. 在 `scopes.cwt` 中补齐缺失的作用域/别名。
2. 在 `links.cwt` 中添加准确的 `input_scopes` 和 `output_scope`。
3. 更新 effect、trigger 或本地化中暴露该链接的别名。
4. 用一个合法样例和一个非法样例确认诊断变化符合预期。

### 校验清单

规则改动后运行针对性检查：

```bash
npm run rules:stellaris:report -- --no-open
dotnet build src/Main/
npm run build:docs
npm run check:release -- --skip-compile --skip-test
```

如果改动影响 MCP 可见的语义行为，也运行：

```bash
npm run build:shared
npm run build:mcp
npm run test:contracts
```

合入前：

- 在 Extension Development Host 中用小型示例 Mod 实测。
- 检查新增诊断、补全、悬停、引用和本地化行为。
- 如果使用了规则同步报告，先审查再把输出复制进稳定 CWT 文件。
- 先在 `submodules/cwtools-stellaris-config/` 内提交，再提交根仓库的
  submodule 指针。

### 常见陷阱

- 不要扁平化重复键；替代结构常通过重复声明表示。
- `##` 选项应紧贴它配置的规则。
- 路径使用正斜杠。
- 除非邻近规则表明游戏数据确实不受约束，否则避免宽泛的 `any`、`all` 和
  `scalar`。
- 当目标集合可知时，优先使用 `enum[...]`、`<type>`、`value[...]` 和
  `scope_group[...]`。
- 不要手工编辑生成式 fallback zip。
- 不要假设其他工具中的规则分类或选项在本项目中可用；只有 CWTools 服务端实际
  消费的语法才算支持。
