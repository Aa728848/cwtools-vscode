# Agent Note: Preserve inline symbol ranges in recursive LSP responses

Status: implemented

## Problem

Repeated inline expansions retain the template's source range. The document
symbol corpus nested equal ranges, so a flat template could produce an outline
whose depth grew with its number of callers. The JSON writer stopped expanding
recursive types at factory depth 20 and replaced deeper required fields with
`null`. At document-symbol level 17 this corrupted line and character values,
matching the reported client-side `asRange` / `Invalid arguments` failure.

## Decision

- The document corpus removes identical symbols and requires strict range
  containment for parenting. Different symbols at the same range remain siblings
  in input order; genuine descendants and crossing ranges retain their behavior.
- JSON writer factories cache deferred writers by type within each factory, so
  recursive record, list, and option types reuse fully initialized writers. The
  cache is limited to the factory's type graph and is not shared across options.
- Serialization tracks runtime traversal depth and throws a recoverable
  `InvalidOperationException` at its safety limit. It does not return a partial
  response containing null required fields. Existing request exception handling
  returns an internal error and keeps the server available.
- Regression tests cover 2000 colocated or identical inline symbols, preserved
  type distinctions and genuine nesting, complete 17- and 64-level document
  symbols, 64 selection-range parents, cycles, excessive depth, and reuse after
  failure. Both changed suites failed against the original code and pass after
  the fix. LSP and Main builds pass with no warnings. All 29 F# regression
  scripts pass; the rules-fallback and overlay-containment suites needed an
  unsandboxed rerun for temporary Git repositories and filesystem link access.
- The minimal Stellaris-model reproduction now returns a one-level outline with
  valid coordinates for 16 and 17 inline invocations. Its erroneous-template
  variant still reports all 17 validation errors while preserving the outline.

## Alternatives considered

- Raising the old factory-depth limit would still manufacture malformed responses
  at another depth and would repeatedly expand the recursive type graph.
- Fixing only equal-range parenting would leave genuinely deep document symbols
  and selection ranges vulnerable to the serializer defect.
- Suppressing client conversion errors would hide broken protocol data.
- Changing inline source positions would disrupt navigation and error provenance.

## Consequences

Opening frequently reused inline templates no longer creates artificial outline
depth. Normal recursive responses retain their required fields, while pathological
depth fails as a single request. The separate client-stop event in the supplied
memory log does not establish its initiating cause; this change addresses the
reproduced outline and serialization defects without changing lifecycle policy.
