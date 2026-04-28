# Support for Dynamic Event Target Scope ID Parsing

This plan details the implementation of prefix-matching support within the F# validation pipeline of CWTools, enabling the language server to properly recognize and validate dynamically evaluated scope IDs corresponding to `save_event_target_as = A_@scope` without hallucinating errors.

## Problem Statement
When modders utilize dynamic variable macros like `@scope` tied to prefixes in Event Targets (e.g. `A_@scope`), the static analysis engine evaluates this strictly as a literal `"A_@scope"`. Downstream codebase uses of the evaluated id like `A_123` or `A_@root` will fail the static string matcher, yielding `ErrorCodes.UnsavedEventTarget`.

## Proposed Changes

We will modify the core event target verification cycle in the F# Validation layer.

### [submodules/cwtools/CWTools/Validation/Stellaris/STLEvents.fs]

#### [MODIFY] [`STLEvents.fs`](file:///c:/Users/A/Documents/cwtools-vscode/submodules/cwtools/CWTools/Validation/Stellaris/STLEvents.fs)
Replace the rigid `Set.difference` checks with a helper `computeUnresolved` that integrates CWTools native `PrefixOptimisedStringSet` for highly efficient prefix matching.

**Code Changes (Around Line 430):**
```fsharp
        let computeUnresolved (expected: Set<string>) (u: Set<string>) =
            let dynamicPrefixes = CWTools.Utilities.Utils2.PrefixOptimisedStringSet()
            expected |> Set.iter (fun (t: string) ->
                let parts = t.Split('@', 2)
                if parts.Length > 1 && parts.[0].Length > 0 then
                    dynamicPrefixes.AddWithIDs(parts.[0])
            )
            u |> Set.filter (fun usedTarget ->
                if expected.Contains(usedTarget) then false
                else
                    let matched = dynamicPrefixes.LongestPrefixMatch(usedTarget.AsSpan())
                    // Must be longer than prefix to be a dynamically resolved target
                    matched = null || usedTarget.Length = matched.Length
            )

        let missing =
            current
            |> List.filter (fun (e, os, s, u, r, ox, x) ->
                let expected = Set.union (Set.union s x) globals
                not (computeUnresolved expected u |> Set.isEmpty))

        let maybeMissing =
            current
            |> List.filter (fun (e, os, s, u, r, ox, x) ->
                let expectedLocal = Set.union s globals
                let expectedGlobal = Set.union (Set.union s x) globals
                not (computeUnresolved expectedLocal u |> Set.isEmpty)
                && (computeUnresolved expectedGlobal u |> Set.isEmpty))

        let createError ((eid, e): string * Node, os, s, u, _, _, x) =
            let expected = Set.union (Set.union s x) globals
            let needed = computeUnresolved expected u |> Set.toList |> String.concat ", "
            Invalid(Guid.NewGuid(), [ inv (ErrorCodes.UnsavedEventTarget eid needed) e ])

        let createWarning ((eid, e): string * Node, os, s, u, _, _, _) =
            let expected = Set.union s globals
            let needed = computeUnresolved expected u |> Set.toList |> String.concat ", "
            Invalid(Guid.NewGuid(), [ inv (ErrorCodes.MaybeUnsavedEventTarget eid needed) e ])
```

### [submodules/cwtools/CWToolsTests/testfiles/validationtests/eventtests/events/eventtargets.txt]

#### [MODIFY] Test Cases
Add concrete events into the existing Stellaris event target validation test files to establish TDD anchors for the new behavior.

```paradox
country_event = {
    id = test_dynamic_targets.1
    trigger = { always = yes }
    immediate = {
        save_event_target_as = A_@scope 
        save_event_target_as = @scope

        # Case 1: Prefix match successfully replaces exact string match
        event_target:A_123 = { }

        # Case 2: Empty prefix properly gets filtered out, True Exact Match kicks in to save it!
        event_target:@scope = { }

        # Case 4: Target string is exactly the prefix length instead of resolving deeper. SHOULD ERROR!
        event_target:A_ = { }
    }
}

country_event = {
    id = test_dynamic_targets.2
    trigger = { always = yes }
    immediate = {
        save_event_target_as = A_@scope
        
        # Case 3: Prefix DOES NOT match (SHOULD RETURN ERROR "UnsavedEventTarget")
        event_target:B_456 = { }
    }
}

country_event = {
    id = test_dynamic_targets.3
    trigger = { always = yes }
    immediate = {
        # Connects the event chain via AST direct reference 
        country_event = { id = test_dynamic_targets.1 }
        
        # Case 5: Propagated evaluation test from test_dynamic_targets.1 chaining
        event_target:A_123 = { } 
    }
}
```


## User Review Required
> [!IMPORTANT]
> Final code and test edge cases reviewed. Approval required to begin execution.

## Verification Plan
1. Ensure the hardcoded test examples correctly compile the AST properly and that `ErrorCodes.UnsavedEventTarget` correctly generates (or omits generation) upon running `dotnet test` internally.
2. Apply the F# modifications.
3. Validate through CI compilation pipeline and confirm tests pass.
