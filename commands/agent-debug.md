---
description: Send one prompt with diagnostic traces enabled, without changing the diagnostics mode
argument-hint: <prompt>
---

Call the `agent_prompt` tool on the `agent-doctor` MCP server with prompt: $ARGUMENTS

Set `diagnostics` to `true` for this call. Relay the tool's output to the user verbatim, preserving its markdown structure (final output, registered tools, and the diagnostic trace).
