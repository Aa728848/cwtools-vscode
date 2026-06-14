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

`--cache` alone is sufficient when the dir holds both the `<game>.cwb` cache and the
extracted rules (as the VS Code extension globalStorage does); `--game-path` is only
needed to build the cache from scratch.

If neither flag is given, the MCP **auto-detects the VS Code cwtools extension cache**
in globalStorage (`Code`/`Code - Insiders`/`VSCodium`/`Cursor`) and reuses it — so once
you've opened the project in the extension at least once, no cache flag is needed.

When no cache can be found, vanilla-dependent tool results carry
`vanillaCache.available = false` plus a warning so clients never treat a mod-only
answer as complete.

## Using from Codex

Codex CLI reads MCP servers from `~/.codex/config.toml` (`[mcp_servers.<name>]`,
shared with the Codex IDE extension). With the VS Code extension cache present,
no cache flag is needed:

```toml
[mcp_servers.cwtools]
command = "node"
args = [
  "C:/Users/A/Documents/cwtools-vscode/packages/cwtools-mcp/dist/cli.js",
  "--workspace", "C:/path/to/your/mod",
  "--game", "stellaris",
  "--stdio",
]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Use forward slashes in TOML (Node accepts them on Windows) to avoid escaping. Start a
Codex session and run `/mcp` to confirm the server and its tools are connected. Add
`--game-path "C:/.../Stellaris"` only if you have never built the cache via the extension.

Load-dependent results (type/scope/rule/definition/diagnostics queries) carry a
`readiness` field. While the project is still loading they come back with
`status: "loading"` and `readiness.ready = false` instead of a misleading empty
answer — poll until `readiness.ready` is true (a few seconds with a pre-built cache).

Write tools are disabled by default. To enable controlled writes:

```sh
cwtools-mcp --workspace /path/to/mod --enable-writes --allow-tool write_localisation --allow-tool edit_pdx_block
```

If `--enable-writes` is omitted, write tools remain visible but fail closed with a structured denial.

## Tools

The package exposes generated schemas for CWTools read tools, diagnostics, project/profile knowledge, completion and symbol navigation, plus guarded write tools for localisation and PDX block replacement.
