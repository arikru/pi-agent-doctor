---
description: Control diagnostic traces for /agent-doctor:agent runs (on|off|status)
argument-hint: on|off|status
---

Call the `diagnostics_mode` tool on the `agent-doctor` MCP server with mode: $ARGUMENTS

If no argument was given, use mode `status`. Report the resulting diagnostics state and active agent back to the user in one short sentence.
