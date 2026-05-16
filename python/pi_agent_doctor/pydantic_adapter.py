"""Generic diagnostics helpers for Pydantic AI agents.

This module is the built-in Python adapter for the ``pi-agent-doctor`` Pi
package. It runs a normal Pydantic AI ``Agent``, inspects standard Pydantic AI
messages/tool metadata, and converts them into the JSON shape consumed by the Pi
extension.

Your agents do not need to import Pi, know about sessions, or emit custom trace
events. Wrap them at the boundary where you expose a diagnostic HTTP endpoint.
"""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai import Agent


@dataclass(frozen=True)
class TraceEvent:
    type: str
    text: str | None = None
    name: str | None = None
    args: Any | None = None
    result: Any | None = None
    raw: Any | None = None
    timestamp: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Serialize for diagnostic clients without noisy null fields."""

        event: dict[str, Any] = {
            "type": self.type,
            "timestamp": self.timestamp or now_ms(),
        }
        if self.text is not None:
            event["text"] = self.text
        if self.name is not None:
            event["name"] = self.name
        if self.args is not None:
            event["args"] = self.args
        if self.result is not None:
            event["result"] = self.result
        if self.raw is not None:
            event["raw"] = self.raw
        return event


@dataclass(frozen=True)
class AgentDiagnosticsResult:
    output: str
    trace: list[TraceEvent]
    registered_tools: list[dict[str, Any]] = field(default_factory=list)


async def run_agent_with_diagnostics(
    agent: Agent[Any, Any],
    prompt: str,
    *,
    mode: str | None = None,
) -> AgentDiagnosticsResult:
    """Run a Pydantic AI agent and collect generic diagnostics.

    This function intentionally takes a normal Pydantic AI ``Agent``. The agent
    does not need to import this module, emit custom events, or expose diagnostic
    endpoints of its own.
    """

    registered_tools = describe_registered_tools(agent)
    result = await agent.run(prompt)
    output = str(result.output)

    trace = [
        TraceEvent(
            type="run_start",
            text="Pydantic AI agent run started",
            args={"prompt": prompt, **({"mode": mode} if mode else {})},
        )
    ]
    for message in result.new_messages():
        trace.extend(trace_message(message))
    trace.append(TraceEvent(type="final", text=output, result={"output": output}))
    return AgentDiagnosticsResult(output=output, trace=trace, registered_tools=registered_tools)


def describe_registered_tools(agent: Agent[Any, Any]) -> list[dict[str, Any]]:
    """Return JSON-serializable metadata for function tools on an agent.

    Pydantic AI currently stores registered function tools on the agent's
    function toolset. This introspection belongs in the diagnostics adapter, not
    in the agent under test. If a future Pydantic AI release exposes a public
    accessor for this metadata, this is the only place that should need to
    change.
    """

    toolset = getattr(agent, "_function_toolset", None)
    raw_tools = getattr(toolset, "tools", {})
    if not isinstance(raw_tools, dict):
        return []

    tools: list[dict[str, Any]] = []
    for name, tool in sorted(raw_tools.items()):
        function_schema = getattr(tool, "function_schema", None)
        parameters = copy.deepcopy(getattr(function_schema, "json_schema", {}))
        return_schema = copy.deepcopy(getattr(function_schema, "return_schema", None))
        tools.append(
            {
                "name": str(name),
                "description": getattr(tool, "description", None)
                or getattr(function_schema, "description", ""),
                "parameters": parameters,
                "returnSchema": return_schema,
                "takesContext": bool(getattr(tool, "takes_ctx", False)),
                "sequential": bool(getattr(tool, "sequential", False)),
                "requiresApproval": bool(getattr(tool, "requires_approval", False)),
            }
        )
    return tools


def trace_message(message: Any) -> list[TraceEvent]:
    events = [
        TraceEvent(
            type=message.__class__.__name__,
            text=f"{message.__class__.__name__} with {len(getattr(message, 'parts', []))} part(s)",
            raw=dump(message),
        )
    ]
    for part in getattr(message, "parts", []):
        events.append(trace_part(part))
    return events


def trace_part(part: Any) -> TraceEvent:
    part_type = part.__class__.__name__

    if hasattr(part, "tool_name") and hasattr(part, "args"):
        return TraceEvent(
            type="tool_call",
            name=getattr(part, "tool_name"),
            args=getattr(part, "args"),
            raw=dump(part),
        )

    if hasattr(part, "tool_name") and hasattr(part, "content"):
        return TraceEvent(
            type="tool_return",
            name=getattr(part, "tool_name"),
            result=getattr(part, "content"),
            raw=dump(part),
        )

    if hasattr(part, "content"):
        return TraceEvent(type=part_type, text=str(getattr(part, "content")), raw=dump(part))

    return TraceEvent(type=part_type, raw=dump(part))


def dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return repr(value)


def now_ms() -> int:
    return int(time.time() * 1000)
