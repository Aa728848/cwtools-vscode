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

Write tools are disabled by default. To enable controlled writes:

```sh
cwtools-mcp --workspace /path/to/mod --enable-writes --allow-tool write_localisation --allow-tool edit_pdx_block
```

If `--enable-writes` is omitted, write tools remain visible but fail closed with a structured denial.

## Tools

The package exposes generated schemas for CWTools read tools, diagnostics, project/profile knowledge, completion and symbol navigation, plus guarded write tools for localisation and PDX block replacement.
