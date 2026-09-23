# Changelog

## 0.1.0 (2026-09-23)

First public release.

- `mcplock init` connects to every configured MCP server and writes `mcp.lock.json` with each tool's name, description, schemas and annotations.
- `mcplock check` reconnects, diffs against the lock and exits 1 on drift. `--update` accepts the new surface.
- `mcplock scan` checks tool text for tool-poisoning patterns, offline from the lock or `--live`.
- `mcplock configs` lists the Claude Desktop, Claude Code, Cursor, VS Code and `.mcp.json` configs it found.
- Stdio, Streamable HTTP and SSE transports.
- `--json` output, `--fail-on` severity threshold, exit codes 0 to 3.
- Composite GitHub Action (`action.yml`).
