"""FastAPI transport helpers for pi-agent-doctor's Pydantic AI adapter."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import Agent

from .pydantic_adapter import AgentDiagnosticsResult, run_agent_with_diagnostics

AgentFactory = Callable[[], Agent[Any, Any] | Awaitable[Agent[Any, Any]]]


class PromptRequest(BaseModel):
    """Generic prompt request from the Pi extension.

    Extra fields are ignored on purpose so agents do not learn about
    caller-specific concepts such as Pi sessions, extension names, or UI state.
    """

    model_config = ConfigDict(extra="ignore")

    prompt: str = Field(..., description="Prompt to send to the agent")
    diagnostics: bool = Field(False, description="Return trace events when true")


def create_app(
    agents: Mapping[str, AgentFactory],
    *,
    default_agent: str = "default",
    title: str = "pi-agent-doctor Pydantic AI Adapter",
) -> FastAPI:
    """Create a FastAPI app exposing Pi-compatible diagnostic endpoints.

    Args:
        agents: Mapping from public agent name to a zero-argument factory that
            returns a Pydantic AI ``Agent``. The factory may be async.
        default_agent: Agent used by ``POST /prompt``.
        title: FastAPI app title.

    Routes:
        GET /health
        POST /prompt
        GET /{agent_name}/health
        POST /{agent_name}/prompt
    """

    if not agents:
        raise ValueError("create_app requires at least one agent factory")
    if default_agent not in agents:
        raise ValueError(f"default_agent {default_agent!r} is not present in agents")

    app = FastAPI(title=title)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "pi-agent-doctor-adapter",
            "defaultAgent": default_agent,
            "agents": sorted(agents),
        }

    @app.post("/prompt")
    async def default_prompt(request: PromptRequest):
        return await run_prompt(default_agent, request)

    @app.get("/{agent_name}/health")
    async def agent_health(agent_name: str) -> dict[str, Any]:
        require_agent(agent_name, agents)
        return {"status": "ok", "service": "pi-agent-doctor-adapter", "agent": agent_name}

    @app.post("/{agent_name}/prompt")
    async def named_prompt(agent_name: str, request: PromptRequest):
        return await run_prompt(agent_name, request)

    async def run_prompt(agent_name: str, request: PromptRequest):
        factory = require_agent(agent_name, agents)
        agent = factory()
        if inspect.isawaitable(agent):
            agent = await agent
        result = await run_agent_with_diagnostics(agent, request.prompt, mode=agent_name)
        return format_prompt_response(result, request.diagnostics)

    return app


def require_agent(agent_name: str, agents: Mapping[str, AgentFactory]) -> AgentFactory:
    factory = agents.get(agent_name)
    if factory is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "unknown_agent", "agent": agent_name, "knownAgents": sorted(agents)},
        )
    return factory


def format_prompt_response(result: AgentDiagnosticsResult, diagnostics: bool):
    payload: dict[str, Any] = {
        "output": result.output,
        "final": result.output,
        "events": [event.to_dict() for event in result.trace] if diagnostics else [],
    }
    if diagnostics and result.registered_tools:
        payload["registeredTools"] = result.registered_tools
    return JSONResponse(payload)
