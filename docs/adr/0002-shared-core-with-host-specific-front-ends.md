# One shared diagnostic core, host-specific front-ends

pi-agent-doctor implements the diagnostic protocol client, event normalization, and trace/report rendering once in `lib/diagnostic-core.js` (plain dependency-free ESM), and keeps host integrations thin: the Pi extension (`extensions/pydantic-diagnostics.ts`) handles Pi commands, widgets, and session persistence, while the Claude Code MCP server (`mcp/server.js`) exposes the same operations as MCP tools. New hosts add a front-end over the core rather than re-implementing the protocol.
