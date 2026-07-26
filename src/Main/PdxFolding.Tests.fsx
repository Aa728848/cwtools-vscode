#load "PdxFolding.fs"

open Main.PdxFolding

let assertEqual expected actual message =
    if expected <> actual then
        failwith $"{message}\nExpected: {expected}\nActual:   {actual}"

let span startLine startCharacter endLine endCharacter =
    { startLine = startLine
      startCharacter = startCharacter
      endLine = endLine
      endCharacter = endCharacter }

let ordinaryEvent =
    "country_event = {\n"
    + "    id = test.1\n"
    + "    option = { name = test.1.a }\n"
    + "}\n"

assertEqual
    [ span 0 16 2 None ]
    (ranges ordinaryEvent)
    "A normal PDX event block should expose a folding range."

let nestedBlocks =
    "outer = {\r\n"
    + "    inner = {\r\n"
    + "        value = yes\r\n"
    + "    }\r\n"
    + "}\r\n"

assertEqual
    [ span 0 8 3 None
      span 1 12 2 None ]
    (ranges nestedBlocks)
    "Nested blocks and CRLF input should produce deterministic ranges."

let ignoredBraces =
    "event = {\n"
    + "    title = \"literal { brace } and escaped \\\" { quote\"\n"
    + "    # comment = { ignored = yes }\n"
    + "    option = {\n"
    + "        name = test.a\n"
    + "    }\n"
    + "}\n"

assertEqual
    [ span 0 8 5 None
      span 3 13 4 None ]
    (ranges ignoredBraces)
    "String and comment braces must not corrupt the folding stack."

assertEqual
    [ span 0 4 1 (Some 10) ]
    (ranges "x = {\n    y = 1 }")
    "A closing brace after content should remain part of the folded range."

assertEqual
    []
    (ranges "broken = {\n    value = yes\n")
    "An unmatched opening brace must not create a bogus range."
