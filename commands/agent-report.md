---
description: Export diagnostic runs from this session as an HTML report
argument-hint: "[path.html]"
---

Call the `agent_report` tool on the `agent-doctor` MCP server. If the user provided a path ($ARGUMENTS), pass it as the `path` argument; otherwise call it with no arguments to use a timestamped default. Tell the user where the report was written.
