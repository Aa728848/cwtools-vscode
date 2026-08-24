# LSP compatibility contracts

`lsp-manifest.json` defines the stable Rust language-server protocol surface. It separates LSP `workspace/executeCommand` from VS Code extension commands and model-visible MCP tools.

Run `npm run check:lsp-contract` after changing server commands, initialize options, capabilities, semantic tokens, or custom notifications. The checker validates the schema-level shape, uniqueness, command handler/advertise/read-effect coverage, exact semantic legend and source anchors. It intentionally fails when an implemented command is missing from the manifest.

The standalone Rust server embeds this manifest and exposes its commands, capabilities, semantic-token legend, and notifications directly.
