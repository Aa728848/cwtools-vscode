module Main.PdxFragmentValidation

/// Run fallback syntax recovery only when the complete CKParser parse failed.
let collectWhenParseFails parseSucceeded empty collect =
    if parseSucceeded then empty else collect ()
