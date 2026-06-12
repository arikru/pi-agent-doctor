---
description: Send a prompt to the active diagnostic agent
argument-hint: <prompt>
---

Call the `agent_prompt` tool on the `agent-doctor` MCP server with prompt: $ARGUMENTS

Do not set the `diagnostics` argument (the session diagnostics mode applies). Relay the tool's output to the user verbatim, preserving its markdown structure. If the tool reports a connection failure, suggest checking that the diagnostic adapter server is running and mention the health-check command from the error message.
