namespace Main.Lang

open System
open System.Collections.Generic

/// Reverse-engineered engine facts for Stellaris script commands.
///
/// One home per fact: the facts themselves live in the CWT rules
/// (`submodules/cwtools-stellaris-config/config/engine_cost.cwt`) as
/// `## cost = ...` / `## engine = ...` comments on each trigger and effect,
/// so rules authors own them and no fact is hardcoded in this backend.
///
/// This module only carries the presentation vocabulary - the cost classes and
/// their localised descriptions - plus the small amount of matching needed to
/// turn a word under the cursor into a cost class when the rule itself does not
/// provide one.
module HoverPerformance =

    /// Cost class of a script command as implemented by the engine. The names
    /// are the values accepted by `## cost = ...` in CWT rules.
    type PerfClass =
        | Constant
        | Logarithmic
        | LinearContainer
        | LinearOwned
        | LinearGalaxy
        | Quadratic
        | CombatScale
        | RefreshBatch
        | LoadScale
        | Quirk

    /// Parse a `## cost = ...` value. Unknown values yield None so a typo in a
    /// rule file degrades to "no annotation" instead of a wrong claim.
    let tryParseClass (raw: string) : PerfClass option =
        if String.IsNullOrWhiteSpace raw then
            None
        else
            match raw.Trim().Trim('"').ToLowerInvariant() with
            | "o1"
            | "constant"
            | "o(1)" -> Some Constant
            | "ologn"
            | "log"
            | "logarithmic"
            | "o(log n)" -> Some Logarithmic
            | "on"
            | "linear"
            | "linear_container"
            | "o(n)" -> Some LinearContainer
            | "linear_owned"
            | "o(n)_owned" -> Some LinearOwned
            | "linear_galaxy"
            | "o(n)_galaxy" -> Some LinearGalaxy
            | "on2"
            | "quadratic"
            | "o(n^2)" -> Some Quadratic
            | "combat"
            | "combat_scale" -> Some CombatScale
            | "refresh_batch" -> Some RefreshBatch
            | "load"
            | "load_scale" -> Some LoadScale
            | "semantics"
            | "quirk" -> Some Quirk
            | _ -> None

    /// Stable token for a class, used by tests and diagnostics.
    let classToken (cls: PerfClass) =
        match cls with
        | Constant -> "o(1)"
        | Logarithmic -> "o(log n)"
        | LinearContainer -> "o(n)"
        | LinearOwned -> "o(n)_owned"
        | LinearGalaxy -> "o(n)_galaxy"
        | Quadratic -> "o(n^2)"
        | CombatScale -> "combat"
        | RefreshBatch -> "refresh_batch"
        | LoadScale -> "load"
        | Quirk -> "semantics"

    let private classInfo (cls: PerfClass) =
        match cls with
        | Constant -> "O(1)", "constant time - hash/index lookup", "常数时间 - 哈希/索引查找"
        | Logarithmic -> "O(log n)", "binary search over a sorted container", "有序容器二分查找"
        | LinearContainer -> "O(n)", "traverses the scope's own container", "遍历作用域自身的容器"
        | LinearOwned -> "O(n)", "traverses everything the scoped country owns", "遍历作用域国家拥有的全部对象"
        | LinearGalaxy -> "O(n)", "traverses a galaxy-wide container", "遍历全银河容器"
        | Quadratic -> "O(n^2)", "nested scans over the same container", "对同一容器嵌套扫描"
        | CombatScale -> "O(combatants)", "recomputed for combat participants", "对每个参战方重算"
        | RefreshBatch -> "O(1) + saved refresh", "O(1) flag that skips one full modifier refresh", "O(1) 开关，省掉一次全量修正刷新"
        | LoadScale -> "load time", "load-time and memory cost, not a per-tick cost", "加载耗时与内存开销，非每 tick 开销"
        | Quirk -> "semantics", "engine behaviour differs from what the docs imply", "引擎行为与文档暗示不同"

    /// A resolved engine-cost annotation for the word under the cursor.
    type Fact =
        { Command: string
          Class: PerfClass
          /// Free-form mechanism text, authored in the rule file. Falls back to
          /// the class description when the rule does not supply one.
          Mechanism: string option
          /// Where the claim was confirmed, authored in the rule file.
          Evidence: string option }

    /// Build an annotation from what the rule file declared.
    let fromRule (command: string) (cls: PerfClass) (mechanism: string option) (evidence: string option) =
        { Command = command
          Class = cls
          Mechanism = mechanism
          Evidence = evidence }

    /// Every *_flag command shares one engine implementation whose scope family
    /// (country, ship, planet, starbase, ...) only selects which flag array the
    /// virtual call returns, so the family-level annotation covers all of them.
    let private hasPrefix (name: string) (prefix: string) =
        name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)

    let private hasSuffix (name: string) (suffix: string) =
        name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)

    /// Family fallbacks, used only when the rule file declares nothing for the
    /// exact command. Kept deliberately small: the rule file is the source of
    /// truth and covers the concrete command names.
    let private familyFallback (name: string) : Fact option =
        if hasSuffix name "_flag" && (hasPrefix name "has_" || hasPrefix name "set_" || hasPrefix name "remove_") then
            Some(fromRule name LinearContainer None (Some "shared flag implementation - see ## engine on the annotated command in triggers.cwt / effects.cwt"))
        elif hasPrefix name "num_owned_" then
            Some(fromRule name LinearOwned None (Some "owned-object count - see ## engine on an annotated num_owned_ command"))
        else
            None

    /// Resolve the annotation for a word, preferring the rule-declared fact and
    /// falling back to the family rule. `lookup` is supplied by the caller so
    /// this module stays independent of the game model.
    let resolve (lookup: string -> Fact option) (word: string) : Fact option =
        if String.IsNullOrWhiteSpace word then
            None
        else
            let name = word.Trim().Trim('"').TrimStart('@')

            if name = "" then
                None
            else
                match lookup name with
                | Some entry -> Some entry
                | None -> familyFallback name

    /// Markdown block for a hover, or None when the command has no recorded fact.
    let describe (uiText: string -> string -> string) (entry: Fact) : string =
        let symbol, en, zh = classInfo entry.Class
        let parts = ResizeArray<string>()
        parts.Add(sprintf "**%s**: `%s` - %s" (uiText "Engine cost" "引擎开销") symbol (uiText en zh))

        match entry.Mechanism with
        | Some mechanism when not (String.IsNullOrWhiteSpace mechanism) ->
            parts.Add(sprintf "**%s**: %s" (uiText "Hardcoded behaviour" "硬编码行为") mechanism)
        | _ -> ()

        match entry.Evidence with
        | Some evidence when not (String.IsNullOrWhiteSpace evidence) ->
            parts.Add(sprintf "**%s**: %s" (uiText "Engine evidence" "引擎证据") evidence)
        | _ ->
            parts.Add(
                sprintf
                    "**%s**: %s"
                    (uiText "Verification" "验证状态")
                    (uiText "not confirmed - treat as a hint, not a measurement" "未确认，仅作提示，不作为实测结论")
            )

        String.Join("\n\n", parts)
