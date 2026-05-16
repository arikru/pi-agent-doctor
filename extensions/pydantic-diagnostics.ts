import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_ENTRY = "pydantic-diagnostics-config-v1";
const RUN_ENTRY = "pydantic-diagnostics-run-v1";

interface AgentConfig {
  name: string;
  baseUrl: string;
}

interface DiagnosticEvent {
  type: string;
  text?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  timestamp: number;
  raw: unknown;
}

interface TraceNode {
  event: DiagnosticEvent;
  children: TraceNode[];
}

interface RegisteredToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  returnSchema?: unknown;
  takesContext?: boolean;
  sequential?: boolean;
  requiresApproval?: boolean;
  raw?: unknown;
}

interface AgentRunRecord {
  version: 1;
  agentName: string;
  baseUrl: string;
  prompt: string;
  finalText: string;
  diagnosticsRequested: boolean;
  events: DiagnosticEvent[];
  registeredTools: RegisteredToolInfo[];
  startedAt: number;
  completedAt: number;
  error?: string;
}

interface ExtensionState {
  agents: AgentConfig[];
  currentAgentName: string;
  diagnosticsEnabled: boolean;
  lastRun?: AgentRunRecord;
}

interface ParsedAgentResponse {
  finalText: string;
  events: DiagnosticEvent[];
  registeredTools: RegisteredToolInfo[];
}

const defaultAgentUrl = process.env.PYDANTIC_AGENT_URL ?? "http://localhost:8000";
const extensionFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(extensionFile), "..");
const builtinPythonAdapterDir = path.join(packageRoot, "python");

const state: ExtensionState = {
  agents: [{ name: "default", baseUrl: defaultAgentUrl }],
  currentAgentName: "default",
  diagnosticsEnabled: false,
};

export default function pydanticDiagnostics(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    restoreState(ctx);
    updateStatus(ctx);
  });

  pi.registerCommand("agent-connect", {
    description: "Register a diagnostic agent endpoint: /agent-connect <name> <base-url>",
    handler: async (args, ctx) => {
      const parsed = parseConnectArgs(args);
      if (!parsed) {
        ctx.ui.notify("Usage: /agent-connect <name> <base-url>", "warning");
        return;
      }

      const urlError = validateBaseUrl(parsed.baseUrl);
      if (urlError) {
        ctx.ui.notify(urlError, "error");
        return;
      }

      upsertAgent(parsed);
      state.currentAgentName = parsed.name;
      persistConfig(pi);
      updateStatus(ctx);
      ctx.ui.notify(`Connected '${parsed.name}' -> ${parsed.baseUrl}`, "info");
    },
  });

  pi.registerCommand("agent-use", {
    description: "Select the active diagnostic agent: /agent-use <name>",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /agent-use <name>", "warning");
        return;
      }
      const agent = findAgent(name);
      if (!agent) {
        ctx.ui.notify(`Unknown agent '${name}'. Run /agents to list configured agents.`, "warning");
        return;
      }
      state.currentAgentName = agent.name;
      persistConfig(pi);
      updateStatus(ctx);
      ctx.ui.notify(`Using diagnostic agent '${agent.name}'`, "info");
    },
  });

  pi.registerCommand("agent-disconnect", {
    description: "Remove a diagnostic agent endpoint: /agent-disconnect <name>",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /agent-disconnect <name>", "warning");
        return;
      }
      if (name === "default") {
        ctx.ui.notify(
          "The default agent cannot be removed; reconnect it with /agent-connect default <url>.",
          "warning",
        );
        return;
      }
      const before = state.agents.length;
      state.agents = state.agents.filter((agent) => agent.name !== name);
      if (state.agents.length === before) {
        ctx.ui.notify(`Unknown agent '${name}'.`, "warning");
        return;
      }
      if (state.currentAgentName === name) {
        state.currentAgentName = state.agents[0]?.name ?? "default";
      }
      persistConfig(pi);
      updateStatus(ctx);
      ctx.ui.notify(`Removed diagnostic agent '${name}'.`, "info");
    },
  });

  pi.registerCommand("agents", {
    description: "List configured diagnostic agents",
    handler: async (_args, ctx) => {
      const lines = state.agents.map((agent) => {
        const marker = agent.name === state.currentAgentName ? "*" : " ";
        return `${marker} ${agent.name} -> ${agent.baseUrl}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("diag", {
    description: "Control diagnostic trace display: /diag on|off|status",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "on") {
        state.diagnosticsEnabled = true;
      } else if (value === "off") {
        state.diagnosticsEnabled = false;
      } else if (value !== "" && value !== "status") {
        ctx.ui.notify("Usage: /diag on|off|status", "warning");
        return;
      }

      persistConfig(pi);
      updateStatus(ctx);
      ctx.ui.notify(
        `Diagnostics are ${state.diagnosticsEnabled ? "on" : "off"}. Active agent: ${state.currentAgentName}`,
        "info",
      );
    },
  });

  pi.registerCommand("agent", {
    description: "Send a prompt to the active diagnostic agent",
    handler: async (args, ctx) => {
      await runAgentPrompt(pi, ctx, args, state.diagnosticsEnabled);
    },
  });

  pi.registerCommand("agent-debug", {
    description: "Send one prompt with diagnostic traces enabled, without changing /diag state",
    handler: async (args, ctx) => {
      await runAgentPrompt(pi, ctx, args, true);
    },
  });

  pi.registerCommand("agent-last-trace", {
    description: "Show the most recent diagnostic trace as a widget",
    handler: async (_args, ctx) => {
      if (!state.lastRun) {
        ctx.ui.notify("No diagnostic agent run has completed in this session yet.", "warning");
        return;
      }
      const lines = formatTraceWidget(state.lastRun);
      ctx.ui.setWidget("pydantic-diagnostics-trace", lines, { placement: "aboveEditor" });
      ctx.ui.notify("Showing last trace widget. Run /agent-clear-trace to hide it.", "info");
    },
  });

  pi.registerCommand("agent-clear-trace", {
    description: "Hide the diagnostic trace widget",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("pydantic-diagnostics-trace", undefined);
      ctx.ui.notify("Diagnostic trace widget hidden.", "info");
    },
  });

  pi.registerCommand("agent-report", {
    description: "Export a Pydantic diagnostic HTML report: /agent-report [path.html]",
    handler: async (args, ctx) => {
      const runs = getStoredRuns(ctx);
      if (runs.length === 0) {
        ctx.ui.notify("No Pydantic diagnostic runs found in this Pi session.", "warning");
        return;
      }

      const outputPath = resolveReportPath(ctx.cwd, args.trim());
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, renderHtmlReport(runs), "utf8");
      ctx.ui.notify(`Wrote diagnostic report: ${outputPath}`, "info");
    },
  });

  pi.registerCommand("agent-doctor-adapter", {
    description: "Show the bundled Pydantic AI adapter path and usage",
    handler: async (_args, ctx) => {
      const exists = existsSync(builtinPythonAdapterDir);
      ctx.ui.notify(formatAdapterInfo(exists), exists ? "info" : "warning");
    },
  });

  pi.registerCommand("agent-doctor-init", {
    description: "Write a starter FastAPI bridge for the bundled Pydantic AI adapter: /agent-doctor-init [path.py]",
    handler: async (args, ctx) => {
      if (!existsSync(builtinPythonAdapterDir)) {
        ctx.ui.notify(
          `Bundled adapter directory was not found at ${builtinPythonAdapterDir}. Reinstall pi-agent-doctor from the package repo.`,
          "error",
        );
        return;
      }
      const outputPath = resolveAdapterStarterPath(ctx.cwd, args.trim());
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, renderAdapterStarter(builtinPythonAdapterDir), "utf8");
      ctx.ui.notify(
        `Wrote ${outputPath}\nRun it with: uvicorn ${path.basename(outputPath, ".py")}:app --host 127.0.0.1 --port 8765`,
        "info",
      );
    },
  });
}

function formatAdapterInfo(adapterExists: boolean): string {
  const status = adapterExists ? "available" : "missing";
  return [
    `Built-in Pydantic AI adapter: ${status}`,
    `Path: ${builtinPythonAdapterDir}`,
    "",
    "Install the Python dependencies if needed:",
    `  pip install -e ${JSON.stringify(`${builtinPythonAdapterDir}[server]`)}`,
    "",
    "Create a starter server in this project:",
    "  /agent-doctor-init agent_doctor_server.py",
    "",
    "Then run:",
    "  uvicorn agent_doctor_server:app --host 127.0.0.1 --port 8765",
    "",
    "Connect Pi:",
    "  /agent-connect default http://127.0.0.1:8765",
  ].join("\n");
}

function resolveAdapterStarterPath(cwd: string, requestedPath: string): string {
  const rawPath = requestedPath || "agent_doctor_server.py";
  const withExtension = rawPath.endsWith(".py") ? rawPath : `${rawPath}.py`;
  return path.isAbsolute(withExtension) ? withExtension : path.resolve(cwd, withExtension);
}

function renderAdapterStarter(adapterDir: string): string {
  const adapterDirLiteral = JSON.stringify(adapterDir);
  return `"""Starter diagnostic HTTP bridge generated by pi-agent-doctor.

Replace build_agent() with your real Pydantic AI agent factory, then run:

    uvicorn agent_doctor_server:app --host 127.0.0.1 --port 8765

Pi will POST prompts to /prompt and named agents to /<agent-name>/prompt.
"""

from __future__ import annotations

import sys

# Use the adapter bundled inside the installed pi-agent-doctor Pi package.
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

async function runAgentPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rawPrompt: string,
  diagnosticsRequested: boolean,
): Promise<void> {
  const prompt = rawPrompt.trim();
  if (!prompt) {
    ctx.ui.notify("Usage: /agent <prompt> or /agent-debug <prompt>", "warning");
    return;
  }

  const agent = getCurrentAgent();
  const startedAt = Date.now();
  const liveLines: string[] = [
    `Agent: ${agent.name}`,
    `Diagnostics: ${diagnosticsRequested ? "on" : "off"}`,
  ];

  ctx.ui.setStatus(
    "pydantic-diagnostics",
    `agent:${agent.name}${diagnosticsRequested ? " diag" : ""}`,
  );
  ctx.ui.setWidget("pydantic-diagnostics-live", liveLines, { placement: "aboveEditor" });

  const events: DiagnosticEvent[] = [];
  let registeredTools: RegisteredToolInfo[] = [];
  let finalText = "";
  let error: string | undefined;

  try {
    const parsed = await requestAgent(agent, prompt, diagnosticsRequested, ctx, (event) => {
      events.push(event);
      if (diagnosticsRequested) {
        liveLines.splice(2, liveLines.length - 2, ...formatRecentEvents(events));
        ctx.ui.setWidget("pydantic-diagnostics-live", liveLines, { placement: "aboveEditor" });
      }
    });
    finalText = parsed.finalText;
    registeredTools = parsed.registeredTools;
    if (events.length === 0) {
      events.push(...parsed.events);
    } else if (parsed.events.length > events.length) {
      events.splice(0, events.length, ...parsed.events);
    }
  } catch (caught) {
    error = getErrorMessage(caught);
    finalText = `Agent request failed: ${error}`;
    ctx.ui.notify(finalText, "error");
  } finally {
    ctx.ui.setWidget("pydantic-diagnostics-live", undefined);
    updateStatus(ctx);
  }

  const run: AgentRunRecord = {
    version: 1,
    agentName: agent.name,
    baseUrl: agent.baseUrl,
    prompt,
    finalText,
    diagnosticsRequested,
    events: diagnosticsRequested ? events : [],
    registeredTools: diagnosticsRequested ? registeredTools : [],
    startedAt,
    completedAt: Date.now(),
    error,
  };

  state.lastRun = run;
  pi.appendEntry(RUN_ENTRY, run);
  pi.sendMessage(
    {
      customType: RUN_ENTRY,
      content: formatRunMessage(run),
      display: true,
      details: run,
    },
    { triggerTurn: false },
  );
}

async function requestAgent(
  agent: AgentConfig,
  prompt: string,
  diagnosticsRequested: boolean,
  ctx: ExtensionContext,
  onEvent: (event: DiagnosticEvent) => void,
): Promise<ParsedAgentResponse> {
  const promptUrl = resolvePromptUrl(agent.baseUrl);
  let response: Response;
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
        sessionId: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getLeafId(),
      }),
      signal: ctx.signal,
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
    const payload: unknown = await response.json();
    return parseAgentPayload(payload);
  }

  const text = await response.text();
  return { finalText: text, events: [], registeredTools: [] };
}

async function readStreamingResponse(
  response: Response,
  onEvent: (event: DiagnosticEvent) => void,
): Promise<ParsedAgentResponse> {
  if (!response.body) {
    return { finalText: "", events: [], registeredTools: [] };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: DiagnosticEvent[] = [];
  const textParts: string[] = [];
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

function parseStreamingLine(line: string): DiagnosticEvent | undefined {
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

function parseAgentPayload(payload: unknown): ParsedAgentResponse {
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

function extractEvents(record: Record<string, unknown>): DiagnosticEvent[] {
  const fields = ["events", "trace", "traces", "spans", "logs", "messages"];
  const events: DiagnosticEvent[] = [];
  for (const field of fields) {
    const value = record[field];
    if (Array.isArray(value)) {
      events.push(...value.map((item) => normalizeEvent(item)));
    }
  }
  return events;
}

function extractRegisteredTools(record: Record<string, unknown>): RegisteredToolInfo[] {
  const fields = ["registeredTools", "registered_tools", "tools", "functionTools", "function_tools"];
  for (const field of fields) {
    const value = record[field];
    if (Array.isArray(value)) {
      return value.map(normalizeRegisteredTool).filter((tool) => tool !== undefined);
    }
  }
  return [];
}

function normalizeRegisteredTool(value: unknown): RegisteredToolInfo | undefined {
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

function normalizeEvent(value: unknown): DiagnosticEvent {
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

function collectFinalText(events: DiagnosticEvent[]): string {
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

function isTextLikeEvent(type: string): boolean {
  return (
    type === "text" ||
    type === "text_delta" ||
    type === "assistant_delta" ||
    type === "assistant_text"
  );
}

function formatRunMessage(run: AgentRunRecord): string {
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

function formatRegisteredToolsMarkdown(tools: RegisteredToolInfo[]): string[] {
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

function formatEventsMarkdown(events: DiagnosticEvent[]): string[] {
  if (events.length === 0) return ["(no diagnostic events returned)"];

  const lines: string[] = [];
  const roots = buildTraceTree(events);
  roots.forEach((node, index) => {
    lines.push(...formatEventNodeMarkdown(node, `${index + 1}`, false), "");
  });
  return lines;
}

function buildTraceTree(events: DiagnosticEvent[]): TraceNode[] {
  const roots: TraceNode[] = [];
  let currentContainer: TraceNode | undefined;

  for (const event of events) {
    const node: TraceNode = { event, children: [] };
    if (currentContainer && isTraceChild(event)) {
      currentContainer.children.push(node);
      continue;
    }

    roots.push(node);
    currentContainer = isTraceContainer(event) ? node : undefined;
  }

  return roots;
}

function isTraceContainer(event: DiagnosticEvent): boolean {
  return event.type === "ModelRequest" || event.type === "ModelResponse";
}

function isTraceChild(event: DiagnosticEvent): boolean {
  return event.type.endsWith("Part") || event.type === "tool_call" || event.type === "tool_return";
}

function formatEventNodeMarkdown(node: TraceNode, number: string, nested: boolean): string[] {
  const { event } = node;
  const heading = `${nested ? "####" : "###"} ${number}. ${event.type}${event.name ? ` — ${event.name}` : ""}`;
  const lines: string[] = [heading];
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

function formatRecentEvents(events: DiagnosticEvent[]): string[] {
  const recent = events.slice(-6);
  if (recent.length === 0) return ["Waiting for diagnostic events..."];
  return recent.map((event) => {
    const label = event.name ? `${event.type}:${event.name}` : event.type;
    const text = event.text ? ` — ${truncate(event.text.replace(/\s+/g, " "), 80)}` : "";
    return `${new Date(event.timestamp).toLocaleTimeString()} ${label}${text}`;
  });
}

function formatTraceWidget(run: AgentRunRecord): string[] {
  const header = [
    `Trace for ${run.agentName} (${new Date(run.completedAt).toLocaleString()})`,
    `Prompt: ${truncate(run.prompt, 120)}`,
  ];
  return [
    ...header,
    ...formatRecentEvents(
      run.events.length > 0
        ? run.events
        : [{ type: "final", text: run.finalText, timestamp: run.completedAt, raw: run.finalText }],
    ),
  ];
}

function renderHtmlReport(runs: AgentRunRecord[]): string {
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

function renderRunHtml(run: AgentRunRecord, index: number): string {
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

function renderRegisteredToolHtml(tool: RegisteredToolInfo): string {
  return `<div class="event">
<h4>${escapeHtml(tool.name)}</h4>
${tool.description ? `<p>${escapeHtml(tool.description)}</p>` : ""}
${tool.parameters != null ? `<p class="meta">Parameters</p><pre>${escapeHtml(stringifyForDisplay(tool.parameters, 50000))}</pre>` : ""}
${tool.returnSchema != null ? `<p class="meta">Return schema</p><pre>${escapeHtml(stringifyForDisplay(tool.returnSchema, 50000))}</pre>` : ""}
<details><summary>Raw tool JSON</summary><pre>${escapeHtml(stringifyForDisplay(tool.raw ?? tool, 50000))}</pre></details>
</div>`;
}

function renderEventHtml(node: TraceNode, number: string, nested: boolean): string {
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

function restoreState(ctx: ExtensionContext): void {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "custom") continue;
    if (entry.customType === CONFIG_ENTRY) {
      const config = parseConfig(entry.data);
      if (config) {
        state.agents = config.agents;
        state.currentAgentName = config.currentAgentName;
        state.diagnosticsEnabled = config.diagnosticsEnabled;
      }
    }
    if (entry.customType === RUN_ENTRY) {
      const run = parseRunRecord(entry.data);
      if (run) state.lastRun = run;
    }
  }
}

function getStoredRuns(ctx: ExtensionContext): AgentRunRecord[] {
  const runs: AgentRunRecord[] = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "custom" || entry.customType !== RUN_ENTRY) continue;
    const run = parseRunRecord(entry.data);
    if (run) runs.push(run);
  }
  return runs;
}

function parseConfig(value: unknown): ExtensionState | undefined {
  if (!isRecord(value)) return undefined;
  const agentsValue = value.agents;
  if (!Array.isArray(agentsValue)) return undefined;
  const agents = agentsValue.map(parseAgentConfig).filter((agent) => agent !== undefined);
  const currentAgentName =
    typeof value.currentAgentName === "string" ? value.currentAgentName : agents[0]?.name;
  const diagnosticsEnabled =
    typeof value.diagnosticsEnabled === "boolean" ? value.diagnosticsEnabled : false;
  if (!currentAgentName || agents.length === 0) return undefined;
  return { agents, currentAgentName, diagnosticsEnabled };
}

function parseAgentConfig(value: unknown): AgentConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== "string" || typeof value.baseUrl !== "string") return undefined;
  return { name: value.name, baseUrl: value.baseUrl };
}

function parseRunRecord(value: unknown): AgentRunRecord | undefined {
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

function persistConfig(pi: ExtensionAPI): void {
  pi.appendEntry(CONFIG_ENTRY, {
    version: 1,
    agents: state.agents,
    currentAgentName: state.currentAgentName,
    diagnosticsEnabled: state.diagnosticsEnabled,
  });
}

function updateStatus(ctx: ExtensionContext): void {
  const agent = getCurrentAgent();
  ctx.ui.setStatus(
    "pydantic-diagnostics",
    `agent:${agent.name}${state.diagnosticsEnabled ? " diag:on" : ""}`,
  );
}

function upsertAgent(agent: AgentConfig): void {
  const index = state.agents.findIndex((candidate) => candidate.name === agent.name);
  if (index >= 0) {
    state.agents[index] = agent;
  } else {
    state.agents.push(agent);
  }
}

function findAgent(name: string): AgentConfig | undefined {
  return state.agents.find((agent) => agent.name === name);
}

function getCurrentAgent(): AgentConfig {
  return (
    findAgent(state.currentAgentName) ??
    state.agents[0] ?? { name: "default", baseUrl: defaultAgentUrl }
  );
}

function parseConnectArgs(args: string): AgentConfig | undefined {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const name = parts[0];
  const baseUrl = parts.slice(1).join(" ");
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) return undefined;
  return { name, baseUrl };
}

function validateBaseUrl(baseUrl: string): string | undefined {
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

function resolvePromptUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/prompt")) {
    url.pathname = path.posix.join(url.pathname, "prompt");
  }
  return url.toString();
}

function resolveHealthUrl(promptUrl: string): string {
  const url = new URL(promptUrl);
  url.pathname = url.pathname.endsWith("/prompt")
    ? `${url.pathname.slice(0, -"/prompt".length)}/health`
    : path.posix.join(url.pathname, "health");
  return url.toString();
}

function resolveReportPath(cwd: string, requestedPath: string): string {
  if (requestedPath) {
    return path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(cwd, `pydantic-agent-diagnostics-${stamp}.html`);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function stringifyForDisplay(value: unknown, maxLength = 6000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... truncated ${text.length - maxLength} characters ...`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function formatFetchError(promptUrl: string, value: unknown): string {
  const baseMessage = getErrorMessage(value);
  const cause = value instanceof Error ? (value as { cause?: unknown }).cause : undefined;
  const causeMessage = cause ? `; cause: ${getErrorMessage(cause)}` : "";
  return [
    `Could not reach diagnostic agent endpoint ${promptUrl}: ${baseMessage}${causeMessage}.`,
    `Verify the server is running and reachable, e.g. curl -sS ${resolveHealthUrl(promptUrl)}`,
  ].join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}
