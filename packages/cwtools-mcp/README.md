# cwtools-mcp

MCP server for CWTools semantic modding assistance.

## Usage

Stdio transport:

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --stdio
```

Streamable HTTP transport:

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --http --host 127.0.0.1 --port 3000
```

The HTTP MCP endpoint is `/mcp`; a lightweight health check is available at `/healthz`.

## Vanilla game data

CWTools semantic results combine your mod with the **vanilla game cache**. Without
it, the server still runs, but results are mod-only: vanilla IDs do not appear and
mod references to vanilla definitions are reported as undefined errors. Provide one
of:

```sh
# Build the cache from a vanilla install (slow first run, then cached)
cwtools-mcp --workspace /path/to/mod --game stellaris --game-path "/path/to/Stellaris"

# Reuse a pre-built <game>.cwb cache dir (e.g. the VS Code extension globalStorage/.cwtools)
cwtools-mcp --workspace /path/to/mod --game stellaris --cache "/path/to/.cwtools"
```

When neither is supplied, vanilla-dependent tool results carry
`vanillaCache.available = false` plus a warning so clients never treat a mod-only
answer as complete.

Write tools are disabled by default. To enable controlled writes:

```sh
cwtools-mcp --workspace /path/to/mod --enable-writes --allow-tool write_localisation --allow-tool edit_pdx_block
```

If `--enable-writes` is omitted, write tools remain visible but fail closed with a structured denial.

## Tools

The package exposes generated schemas for CWTools read tools, diagnostics, project/profile knowledge, completion and symbol navigation, plus guarded write tools for localisation and PDX block replacement.
