---
description: Register a diagnostic agent endpoint and make it active
argument-hint: <name> <base-url>
---

Call the `agent_connect` tool on the `agent-doctor` MCP server. Parse the arguments: $ARGUMENTS

The first word is `name`, the rest is `baseUrl`. If either is missing, tell the user the usage is `/agent-doctor:agent-connect <name> <base-url>` and stop. Report the tool's result back to the user.
