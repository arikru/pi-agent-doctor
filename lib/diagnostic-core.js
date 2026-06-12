/**
 * Shared diagnostic-protocol core for pi-agent-doctor.
 *
 * This module is host-agnostic: it implements the common HTTP diagnostic
 * protocol (see docs/adr/0001), event normalization, trace formatting, and
 * report rendering. It is consumed by both the Pi extension
 * (extensions/pydantic-diagnostics.ts) and the Claude Code MCP server
 * (mcp/server.js), so it must stay plain ESM JavaScript with no dependencies.
 *
 * @typedef {{ name: string, baseUrl: string }} AgentConfig
 * @typedef {{ type: string, text?: string, name?: string, args?: unknown, result?: unknown, timestamp: number, raw: unknown }} DiagnosticEvent
 * @typedef {{ event: DiagnosticEvent, children: TraceNode[] }} TraceNode
 * @typedef {{ name: string, description?: string, parameters?: unknown, returnSchema?: unknown, takesContext?: boolean, sequential?: boolean, requiresApproval?: boolean, raw?: unknown }} RegisteredToolInfo
 * @typedef {{ version: 1, agentName: string, baseUrl: string, prompt: string, finalText: string, diagnosticsRequested: boolean, events: DiagnosticEvent[], registeredTools: RegisteredToolInfo[], startedAt: number, completedAt: number, error?: string }} AgentRunRecord
 * @typedef {{ finalText: string, events: DiagnosticEvent[], registeredTools: RegisteredToolInfo[] }} ParsedAgentResponse
 */

import path from "node:path";

/**
 * POST a prompt to a diagnostic adapter and parse the response.
 *
 * @param {AgentConfig} agent
 * @param {string} prompt
 * @param {boolean} diagnosticsRequested
 * @param {{ signal?: AbortSignal, sessionId?: string, onEvent?: (event: DiagnosticEvent) => void }} [options]
 * @returns {Promise<ParsedAgentResponse>}
 */
export async function requestAgent(agent, prompt, diagnosticsRequested, options = {}) {
  const promptUrl = resolvePromptUrl(agent.baseUrl);
  const onEvent = options.onEvent ?? (() => {});
  let response;
  try {
    response = await fetch(promptUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream, application/x-ndjson, text/plain",
      },
      body: JSON.stringify({
        prompt,
        diagnostics: diagnosticsRequested,
        agent: agent.name,
        sessionId: options.sessionId,
      }),
      signal: options.signal,
    });
  } catch (caught) {
    throw new Error(formatFetchError(promptUrl, caught));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson")) {
    return readStreamingResponse(response, onEvent);
  }

  if (contentType.includes("application/json")) {
    const payload = await response.json();
    return parseAgentPayload(payload);
  }

  const text = await response.text();
  return { finalText: text, events: [], registeredTools: [] };
}

/**
 * @param {Response} response
 * @param {(event: DiagnosticEvent) => void} onEvent
 * @returns {Promise<ParsedAgentResponse>}
 */
async function readStreamingResponse(response, onEvent) {
  if (!response.body) {
    return { finalText: "", events: [], registeredTools: [] };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const textParts = [];
  let finalText = "";
  let buffer = "";

  while (true) {
    const readResult = await reader.read();
    if (readResult.done) break;
    buffer += decoder.decode(readResult.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseStreamingLine(line);
      if (!event) continue;
      events.push(event);
      onEvent(event);
      const text = event.text ?? "";
      if (event.type === "final" || event.type === "done") {
        finalText = text;
      } else if (isTextLikeEvent(event.type)) {
        textParts.push(text);
      }
    }
  }

  buffer += decoder.decode();
  const remaining = parseStreamingLine(buffer);
  if (remaining) {
    events.push(remaining);
    onEvent(remaining);
    if (remaining.type === "final" || remaining.type === "done") {
      finalText = remaining.text ?? "";
    } else if (isTextLikeEvent(remaining.type)) {
      textParts.push(remaining.text ?? "");
    }
  }

  return { finalText: finalText || textParts.join(""), events, registeredTools: [] };
}

/**
 * @param {string} line
 * @returns {DiagnosticEvent | undefined}
 */
function parseStreamingLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return undefined;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === "[DONE]") return undefined;

  const parsed = tryParseJson(payload);
  if (parsed.ok) {
    return normalizeEvent(parsed.value);
  }

  return {
    type: "text_delta",
    text: payload,
    timestamp: Date.now(),
    raw: payload,
  };
}

/**
 * @param {unknown} payload
 * @returns {ParsedAgentResponse}
 */
export function parseAgentPayload(payload) {
  if (typeof payload === "string") {
    return { finalText: payload, events: [], registeredTools: [] };
  }

  if (Array.isArray(payload)) {
    const events = payload.map((item) => normalizeEvent(item));
    return { finalText: collectFinalText(events), events, registeredTools: [] };
  }

  if (!isRecord(payload)) {
    return { finalText: JSON.stringify(payload), events: [], registeredTools: [] };
  }

  const explicitFinal = firstString(payload, [
    "final",
    "answer",
    "output",
    "text",
    "content",
    "message",
    "result",
  ]);
  const events = extractEvents(payload);
  const registeredTools = extractRegisteredTools(payload);
  const singleEvent = firstString(payload, ["type", "event", "kind"])
    ? normalizeEvent(payload)
    : undefined;
  if (singleEvent) events.push(singleEvent);

  return {
    finalText: explicitFinal ?? collectFinalText(events),
    events,
    registeredTools,
  };
}

/**
 * @param {Record<string, unknown>} record
 * @returns {DiagnosticEvent[]}
 */
function extractEvents(record) {
  const fields = ["events", "trace", "traces", "spans", "logs", "messages"];
  const events = [];
  for (const field of fields) {
    const value = record[field];
    if (Array.isArray(value)) {
      events.push(...value.map((item) => normalizeEvent(item)));
    }
  }
  return events;
}

/**
 * @param {Record<string, unknown>} record
 * @returns {RegisteredToolInfo[]}
 */
function extractRegisteredTools(record) {
  const fields = ["registeredTools", "registered_tools", "tools", "functionTools", "function_tools"];
  for (const field of fields) {
    const value = record[field];
    if (Array.isArray(value)) {
      return value.map(normalizeRegisteredTool).filter((tool) => tool !== undefined);
    }
  }
  return [];
}

/**
 * @param {unknown} value
 * @returns {RegisteredToolInfo | undefined}
 */
export function normalizeRegisteredTool(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = firstString(value, ["name", "toolName", "tool_name"]);
  if (!name) return undefined;
  return {
    name,
    description: firstString(value, ["description", "summary"]),
    parameters: firstPresent(value, ["parameters", "schema", "jsonSchema", "json_schema", "inputSchema"]),
    returnSchema: firstPresent(value, ["returnSchema", "return_schema", "outputSchema", "output_schema"]),
    takesContext: booleanField(value, ["takesContext", "takes_ctx"]),
    sequential: booleanField(value, ["sequential"]),
    requiresApproval: booleanField(value, ["requiresApproval", "requires_approval"]),
    raw: value,
  };
}

/**
 * @param {unknown} value
 * @returns {DiagnosticEvent}
 */
export function normalizeEvent(value) {
  if (!isRecord(value)) {
    return {
      type: "event",
      text: typeof value === "string" ? value : JSON.stringify(value),
      timestamp: Date.now(),
      raw: value,
    };
  }

  const type = firstString(value, ["type", "event", "kind", "name"]) ?? "event";
  const text = firstString(value, [
    "text",
    "delta",
    "content",
    "message",
    "reasoning",
    "final",
    "answer",
    "output",
  ]);
  const name = firstString(value, [
    "tool",
    "tool_name",
    "toolName",
    "function",
    "function_name",
    "span",
    "name",
  ]);
  const args = firstPresent(value, ["args", "arguments", "input", "parameters", "kwargs"]);
  const result = firstPresent(value, ["result", "output", "return", "observation", "content"]);
  const timestamp = numberField(value, "timestamp") ?? Date.now();

  return { type, text, name, args, result, timestamp, raw: value };
}

/**
 * @param {DiagnosticEvent[]} events
 * @returns {string}
 */
function collectFinalText(events) {
  const finalEvent = findLast(
    events,
    (event) => event.type === "final" || event.type === "done" || event.type === "answer",
  );
  if (finalEvent?.text) return finalEvent.text;
  return events
    .filter((event) => isTextLikeEvent(event.type))
    .map((event) => event.text ?? "")
    .join("");
}

/**
 * @param {string} type
 * @returns {boolean}
 */
function isTextLikeEvent(type) {
  return (
    type === "text" ||
    type === "text_delta" ||
    type === "assistant_delta" ||
    type === "assistant_text"
  );
}

/**
 * @param {AgentRunRecord} run
 * @returns {string}
 */
export function formatRunMessage(run) {
  const sections = [
    `# Diagnostic Agent: ${run.agentName}`,
    `Endpoint: ${run.baseUrl}`,
    `Diagnostics: ${run.diagnosticsRequested ? "on" : "off"}`,
    "",
    "## Prompt",
    run.prompt,
    "",
    "## Final Output",
    run.finalText || "(no final output)",
  ];

  if (run.error) {
    sections.push("", "## Error", run.error);
  }

  if (run.diagnosticsRequested && run.registeredTools.length > 0) {
    sections.push("", "## Registered Tools", ...formatRegisteredToolsMarkdown(run.registeredTools));
  }

  if (run.diagnosticsRequested) {
    sections.push("", "## Diagnostic Trace", ...formatEventsMarkdown(run.events));
  }

  return sections.join("\n");
}

/**
 * @param {RegisteredToolInfo[]} tools
 * @returns {string[]}
 */
function formatRegisteredToolsMarkdown(tools) {
  return tools.flatMap((tool) => {
    const lines = [`### ${tool.name}`];
    if (tool.description) lines.push(tool.description);
    const flags = [
      tool.takesContext ? "takes context" : undefined,
      tool.sequential ? "sequential" : undefined,
      tool.requiresApproval ? "requires approval" : undefined,
    ].filter(Boolean);
    if (flags.length > 0) lines.push(`Flags: ${flags.join(", ")}`);
    if (tool.parameters != null) {
      lines.push("", "Parameters:", "```json", stringifyForDisplay(tool.parameters), "```");
    }
    if (tool.returnSchema != null) {
      lines.push("", "Return schema:", "```json", stringifyForDisplay(tool.returnSchema), "```");
    }
    lines.push("");
    return lines;
  });
}

/**
 * @param {DiagnosticEvent[]} events
 * @returns {string[]}
 */
export function formatEventsMarkdown(events) {
  if (events.length === 0) return ["(no diagnostic events returned)"];

  const lines = [];
  const roots = buildTraceTree(events);
  roots.forEach((node, index) => {
    lines.push(...formatEventNodeMarkdown(node, `${index + 1}`, false), "");
  });
  return lines;
}

/**
 * @param {DiagnosticEvent[]} events
 * @returns {TraceNode[]}
 */
export function buildTraceTree(events) {
  const roots = [];
  let currentContainer;

  for (const event of events) {
    const node = { event, children: [] };
    if (currentContainer && isTraceChild(event)) {
      currentContainer.children.push(node);
      continue;
    }

    roots.push(node);
    currentContainer = isTraceContainer(event) ? node : undefined;
  }

  return roots;
}

/**
 * @param {DiagnosticEvent} event
 * @returns {boolean}
 */
function isTraceContainer(event) {
  return event.type === "ModelRequest" || event.type === "ModelResponse";
}

/**
 * @param {DiagnosticEvent} event
 * @returns {boolean}
 */
function isTraceChild(event) {
  return event.type.endsWith("Part") || event.type === "tool_call" || event.type === "tool_return";
}

/**
 * @param {TraceNode} node
 * @param {string} number
 * @param {boolean} nested
 * @returns {string[]}
 */
function formatEventNodeMarkdown(node, number, nested) {
  const { event } = node;
  const heading = `${nested ? "####" : "###"} ${number}. ${event.type}${event.name ? ` — ${event.name}` : ""}`;
  const lines = [heading];
  const quote = nested ? "> " : "";

  if (event.text) {
    lines.push(...event.text.split(/\r?\n/).map((line) => `${quote}${line}`));
  }
  if (event.args != null) {
    lines.push("", `${quote}Arguments:`, `${quote}\`\`\`json`);
    lines.push(...stringifyForDisplay(event.args).split(/\r?\n/).map((line) => `${quote}${line}`));
    lines.push(`${quote}\`\`\``);
  }
  if (event.result != null) {
    lines.push("", `${quote}Result:`, `${quote}\`\`\`json`);
    lines.push(...stringifyForDisplay(event.result).split(/\r?\n/).map((line) => `${quote}${line}`));
    lines.push(`${quote}\`\`\``);
  }

  node.children.forEach((child, index) => {
    lines.push("", ...formatEventNodeMarkdown(child, `${number}.${index + 1}`, true));
  });

  return lines;
}

/**
 * @param {DiagnosticEvent[]} events
 * @returns {string[]}
 */
export function formatRecentEvents(events) {
  const recent = events.slice(-6);
  if (recent.length === 0) return ["Waiting for diagnostic events..."];
  return recent.map((event) => {
    const label = event.name ? `${event.type}:${event.name}` : event.type;
    const text = event.text ? ` — ${truncate(event.text.replace(/\s+/g, " "), 80)}` : "";
    return `${new Date(event.timestamp).toLocaleTimeString()} ${label}${text}`;
  });
}

/**
 * @param {AgentRunRecord[]} runs
 * @returns {string}
 */
export function renderHtmlReport(runs) {
  const renderedRuns = runs.map((run, index) => renderRunHtml(run, index + 1)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pydantic Agent Diagnostic Report</title>
<style>
:root { color-scheme: dark; --bg: #111827; --card: #1f2937; --muted: #9ca3af; --text: #f9fafb; --accent: #60a5fa; --error: #f87171; --border: #374151; }
body { margin: 0; padding: 2rem; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
main { max-width: 1100px; margin: 0 auto; }
section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; margin: 1rem 0; }
h1, h2, h3 { margin-top: 0; }
.meta { color: var(--muted); font-size: 0.9rem; }
pre { white-space: pre-wrap; overflow-x: auto; background: #0b1020; border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; }
.event { border-top: 1px solid var(--border); padding-top: 0.75rem; margin-top: 0.75rem; }
.event.child { margin-left: 1.5rem; border-left: 2px solid var(--border); padding-left: 1rem; }
.error { color: var(--error); }
.badge { color: var(--bg); background: var(--accent); border-radius: 999px; padding: 0.1rem 0.5rem; font-size: 0.8rem; }
</style>
</head>
<body>
<main>
<h1>Pydantic Agent Diagnostic Report</h1>
<p class="meta">Generated ${escapeHtml(new Date().toISOString())} · ${runs.length} run${runs.length === 1 ? "" : "s"}</p>
${renderedRuns}
</main>
</body>
</html>
`;
}

/**
 * @param {AgentRunRecord} run
 * @param {number} index
 * @returns {string}
 */
function renderRunHtml(run, index) {
  const events = buildTraceTree(run.events)
    .map((node, eventIndex) => renderEventHtml(node, `${eventIndex + 1}`, false))
    .join("\n");
  const registeredTools = run.registeredTools.map(renderRegisteredToolHtml).join("\n");
  return `<section>
<h2>Run ${index}: ${escapeHtml(run.agentName)} <span class="badge">diagnostics ${run.diagnosticsRequested ? "on" : "off"}</span></h2>
<p class="meta">${escapeHtml(new Date(run.startedAt).toISOString())} → ${escapeHtml(new Date(run.completedAt).toISOString())} · ${escapeHtml(run.baseUrl)}</p>
<h3>Prompt</h3>
<pre>${escapeHtml(run.prompt)}</pre>
<h3>Final Output</h3>
<pre>${escapeHtml(run.finalText || "(no final output)")}</pre>
${run.error ? `<h3 class="error">Error</h3><pre>${escapeHtml(run.error)}</pre>` : ""}
${registeredTools ? `<h3>Registered Tools</h3>${registeredTools}` : ""}
<h3>Diagnostic Events</h3>
${events || '<p class="meta">No diagnostic events captured for this run.</p>'}
</section>`;
}

/**
 * @param {RegisteredToolInfo} tool
 * @returns {string}
 */
function renderRegisteredToolHtml(tool) {
  return `<div class="event">
<h4>${escapeHtml(tool.name)}</h4>
${tool.description ? `<p>${escapeHtml(tool.description)}</p>` : ""}
${tool.parameters != null ? `<p class="meta">Parameters</p><pre>${escapeHtml(stringifyForDisplay(tool.parameters, 50000))}</pre>` : ""}
${tool.returnSchema != null ? `<p class="meta">Return schema</p><pre>${escapeHtml(stringifyForDisplay(tool.returnSchema, 50000))}</pre>` : ""}
<details><summary>Raw tool JSON</summary><pre>${escapeHtml(stringifyForDisplay(tool.raw ?? tool, 50000))}</pre></details>
</div>`;
}

/**
 * @param {TraceNode} node
 * @param {string} number
 * @param {boolean} nested
 * @returns {string}
 */
function renderEventHtml(node, number, nested) {
  const event = node.event;
  const children = node.children
    .map((child, index) => renderEventHtml(child, `${number}.${index + 1}`, true))
    .join("\n");
  return `<div class="event${nested ? " child" : ""}">
<h4>${number}. ${escapeHtml(event.type)}${event.name ? ` — ${escapeHtml(event.name)}` : ""}</h4>
${event.text ? `<pre>${escapeHtml(event.text)}</pre>` : ""}
${event.args != null ? `<p class="meta">Arguments</p><pre>${escapeHtml(stringifyForDisplay(event.args, 50000))}</pre>` : ""}
${event.result != null ? `<p class="meta">Result</p><pre>${escapeHtml(stringifyForDisplay(event.result, 50000))}</pre>` : ""}
<details><summary>Raw event JSON</summary><pre>${escapeHtml(stringifyForDisplay(event.raw, 50000))}</pre></details>
${children}
</div>`;
}

/**
 * @param {unknown} value
 * @returns {AgentRunRecord | undefined}
 */
export function parseRunRecord(value) {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.agentName !== "string") return undefined;
  if (typeof value.baseUrl !== "string") return undefined;
  if (typeof value.prompt !== "string") return undefined;
  if (typeof value.finalText !== "string") return undefined;
  if (typeof value.diagnosticsRequested !== "boolean") return undefined;
  if (typeof value.startedAt !== "number" || typeof value.completedAt !== "number")
    return undefined;
  const rawEvents = value.events;
  const events = Array.isArray(rawEvents) ? rawEvents.map(normalizeEvent) : [];
  const rawRegisteredTools = value.registeredTools;
  const registeredTools = Array.isArray(rawRegisteredTools)
    ? rawRegisteredTools.map(normalizeRegisteredTool).filter((tool) => tool !== undefined)
    : [];
  const error = typeof value.error === "string" ? value.error : undefined;
  return {
    version: 1,
    agentName: value.agentName,
    baseUrl: value.baseUrl,
    prompt: value.prompt,
    finalText: value.finalText,
    diagnosticsRequested: value.diagnosticsRequested,
    events,
    registeredTools,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    error,
  };
}

/**
 * @param {string} baseUrl
 * @returns {string | undefined} an error message, or undefined when valid
 */
export function validateBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Agent URL must start with http:// or https://";
    }
    return undefined;
  } catch {
    return `Invalid agent URL: ${baseUrl}`;
  }
}

/**
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolvePromptUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/prompt")) {
    url.pathname = path.posix.join(url.pathname, "prompt");
  }
  return url.toString();
}

/**
 * @param {string} promptUrl
 * @returns {string}
 */
export function resolveHealthUrl(promptUrl) {
  const url = new URL(promptUrl);
  url.pathname = url.pathname.endsWith("/prompt")
    ? `${url.pathname.slice(0, -"/prompt".length)}/health`
    : path.posix.join(url.pathname, "health");
  return url.toString();
}

/**
 * @param {string} cwd
 * @param {string} requestedPath
 * @returns {string}
 */
export function resolveReportPath(cwd, requestedPath) {
  if (requestedPath) {
    return path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(cwd, `pydantic-agent-diagnostics-${stamp}.html`);
}

/**
 * @param {string} cwd
 * @param {string} requestedPath
 * @returns {string}
 */
export function resolveAdapterStarterPath(cwd, requestedPath) {
  const rawPath = requestedPath || "agent_doctor_server.py";
  const withExtension = rawPath.endsWith(".py") ? rawPath : `${rawPath}.py`;
  return path.isAbsolute(withExtension) ? withExtension : path.resolve(cwd, withExtension);
}

/**
 * @param {string} adapterDir
 * @returns {string}
 */
export function renderAdapterStarter(adapterDir) {
  const adapterDirLiteral = JSON.stringify(adapterDir);
  return `"""Starter diagnostic HTTP bridge generated by pi-agent-doctor.

Replace build_agent() with your real Pydantic AI agent factory, then run:

    uvicorn agent_doctor_server:app --host 127.0.0.1 --port 8765

Clients POST prompts to /prompt and named agents to /<agent-name>/prompt.
"""

from __future__ import annotations

import sys

# Use the adapter bundled inside the installed pi-agent-doctor package.
sys.path.insert(0, ${adapterDirLiteral})

from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pi_agent_doctor.fastapi_adapter import create_app


def build_agent():
    """TODO: replace this with your real Pydantic AI Agent factory."""

    return Agent(
        TestModel(custom_output_text="pi-agent-doctor adapter is wired"),
        system_prompt="You are a smoke-test Pydantic AI agent.",
    )


app = create_app({"default": build_agent})
`;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {string | undefined}
 */
function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {unknown}
 */
function firstPresent(record, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {number | undefined}
 */
function numberField(record, key) {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {boolean | undefined}
 */
function booleanField(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/**
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function stringifyForDisplay(value, maxLength = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... truncated ${text.length - maxLength} characters ...`;
}

/**
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function getErrorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/**
 * @param {string} promptUrl
 * @param {unknown} value
 * @returns {string}
 */
function formatFetchError(promptUrl, value) {
  const baseMessage = getErrorMessage(value);
  const cause = value instanceof Error ? value.cause : undefined;
  const causeMessage = cause ? `; cause: ${getErrorMessage(cause)}` : "";
  return [
    `Could not reach diagnostic agent endpoint ${promptUrl}: ${baseMessage}${causeMessage}.`,
    `Verify the server is running and reachable, e.g. curl -sS ${resolveHealthUrl(promptUrl)}`,
  ].join(" ");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {DiagnosticEvent[]} items
 * @param {(item: DiagnosticEvent) => boolean} predicate
 * @returns {DiagnosticEvent | undefined}
 */
function findLast(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}
