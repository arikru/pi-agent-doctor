# pi-agent-doctor

A sharable [Pi](https://pi.dev) package that adds diagnostic-agent commands to Pi.

`pi-agent-doctor` lets Pi talk to an HTTP diagnostic adapter for Pydantic AI agents, stream trace events into the Pi UI, persist run records in the Pi session, and export HTML diagnostic reports.

> Security note: Pi extensions run with your full local user permissions. Review extension code before installing any Pi package.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/arikru/pi-agent-doctor
```

Or try it for one Pi run without adding it to settings:

```bash
pi -e git:github.com/arikru/pi-agent-doctor
```

For local development:

```bash
git clone https://github.com/arikru/pi-agent-doctor.git
cd pi-agent-doctor
pi -e ./
```

## What this package includes

This package installs one Pi extension:

```text
extensions/pydantic-diagnostics.ts
```

It does **not** start or install a Python/Pydantic AI server. You need to run a compatible diagnostic agent endpoint separately and point the extension at it.

By default the extension uses:

```text
PYDANTIC_AGENT_URL or http://localhost:8000
```

Example:

```bash
PYDANTIC_AGENT_URL=http://127.0.0.1:8765 pi
```

## Pi commands

After installing/loading the package, these commands are available in Pi:

| Command | Purpose |
| --- | --- |
| `/agent <prompt>` | Send a prompt to the active diagnostic agent. |
| `/agent-debug <prompt>` | Send one prompt with diagnostics enabled, without changing `/diag` state. |
| `/diag on\|off\|status` | Control whether normal `/agent` runs request diagnostics. |
| `/agent-connect <name> <base-url>` | Register/connect a named diagnostic agent endpoint. |
| `/agent-use <name>` | Select the active diagnostic agent. |
| `/agent-disconnect <name>` | Remove a named diagnostic agent endpoint. |
| `/agents` | List configured diagnostic agents. |
| `/agent-last-trace` | Show the most recent diagnostic trace as a Pi widget. |
| `/agent-clear-trace` | Hide the diagnostic trace widget. |
| `/agent-report [path.html]` | Export stored diagnostic runs from the current Pi session as an HTML report. |

## Example usage

Start Pi with a default diagnostic endpoint:

```bash
PYDANTIC_AGENT_URL=http://127.0.0.1:8765 pi
```

Then in Pi:

```text
/agent-debug extension bridge smoke test
```

Connect to another path-specific agent endpoint:

```text
/agent-connect trace-agent http://127.0.0.1:8765/tool-reasoning
/agent-debug what is the status of order A100 incl. total and delivery ETA
```

Toggle diagnostics for regular `/agent` calls:

```text
/diag on
/agent what tools did you call?
```

Export a report:

```text
/agent-report doctor-report.html
```

## Expected HTTP endpoint

For an agent base URL such as:

```text
http://127.0.0.1:8765/tool-reasoning
```

`pi-agent-doctor` posts to:

```text
http://127.0.0.1:8765/tool-reasoning/prompt
```

If the base URL already ends in `/prompt`, it posts there directly.

Request body:

```json
{
  "prompt": "user prompt text",
  "diagnostics": true,
  "agent": "active-agent-name",
  "sessionId": "pi-session-id-or-leaf-id"
}
```

The response may be:

- `application/json`
- `text/event-stream`
- `application/x-ndjson`
- `text/plain`

JSON responses can be a string, an array of events, or an object with fields such as:

```json
{
  "final": "final answer text",
  "events": [
    {
      "type": "ModelRequest",
      "text": "...",
      "timestamp": 1760000000000
    }
  ],
  "registeredTools": [
    {
      "name": "lookup_order",
      "description": "Look up an order",
      "parameters": {}
    }
  ]
}
```

Streaming responses can emit SSE `data:` records or NDJSON records. Each record is normalized as a diagnostic event. Events with types like `final`, `done`, or `answer` are treated as final text when possible.

## Package structure

```text
.
├── extensions/
│   └── pydantic-diagnostics.ts
├── package.json
├── README.md
└── LICENSE
```

The `package.json` declares the Pi package manifest:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/pydantic-diagnostics.ts"]
  }
}
```

## Development checks

```bash
npm run check
```

This currently runs `npm pack --dry-run` to verify the package contents that would be published.
