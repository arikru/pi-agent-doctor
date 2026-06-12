---
description: Write a starter FastAPI bridge for the bundled Pydantic AI adapter
argument-hint: "[path.py]"
---

Call the `adapter_init` tool on the `agent-doctor` MCP server. If the user provided a path ($ARGUMENTS), pass it as the `path` argument; otherwise call it with no arguments to write `agent_doctor_server.py`. Relay the tool's output, including the uvicorn command for running the generated server.
