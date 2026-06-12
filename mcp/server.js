#!/usr/bin/env node
/**
 * Claude Code MCP server for pi-agent-doctor.
 *
 * Exposes the common HTTP diagnostic protocol (docs/adr/0001) as MCP tools so
 * Claude Code can prompt diagnostic agents, inspect traces, and export
 * reports. Speaks newline-delimited JSON-RPC 2.0 over stdio with no runtime
 * dependencies, so it runs with any Node.js that has global fetch (>= 18).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatEventsMarkdown,
  formatRunMessage,
  getErrorMessage,
  isRecord,
  renderAdapterStarter,
  renderHtmlReport,
  requestAgent,
  resolveAdapterStarterPath,
  resolveReportPath,
  validateBaseUrl,
} from "../lib/diagnostic-core.js";

const SERVER_NAME = "pi-agent-doctor";
const SERVER_VERSION = "0.3.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const serverFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(serverFile), "..");
const builtinPythonAdapterDir = path.join(packageRoot, "python");
const workingDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const defaultAgentUrl = process.env.PYDANTIC_AGENT_URL ?? "http://localhost:8000";
const stateFile = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "pi-agent-doctor",
  "mcp-state.json",
);

const state = {
  agents: [{ name: "default", baseUrl: defaultAgentUrl }],
  currentAgentName: "default",
  diagnosticsEnabled: false,
  /** Runs are kept in memory for the lifetime of the Claude Code session. */
  runs: [],
};

await loadPersistedConfig();

const tools = [
  {
    name: "agent_prompt",
    description:
      "Send a prompt to the active diagnostic agent (a Pydantic AI agent behind a pi-agent-doctor HTTP adapter) and return its final output, plus the diagnostic trace and registered tools when diagnostics are enabled. Set diagnostics=true for a one-off traced run.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt text to send to the diagnostic agent" },
        diagnostics: {
          type: "boolean",
          description:
            "Request the diagnostic trace for this run. Defaults to the session diagnostics mode (see diagnostics_mode).",
        },
        agent: {
          type: "string",
          description: "Name of a connected agent to use instead of the active one",
        },
      },
      required: ["prompt"],
    },
    handler: handleAgentPrompt,
  },
  {
    name: "agent_connect",
    description:
      "Register a named diagnostic agent endpoint (base URL of a pi-agent-doctor HTTP adapter) and make it the active agent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (letters, digits, ., _, -)" },
        baseUrl: {
          type: "string",
          description: "Adapter base URL, e.g. http://127.0.0.1:8765 or http://127.0.0.1:8765/orders",
        },
      },
      required: ["name", "baseUrl"],
    },
    handler: handleAgentConnect,
  },
  {
    name: "agent_use",
    description: "Select which connected diagnostic agent receives agent_prompt calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of a connected agent" },
      },
      required: ["name"],
    },
    handler: handleAgentUse,
  },
  {
    name: "agent_disconnect",
    description: "Remove a named diagnostic agent endpoint (the 'default' agent cannot be removed).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the agent to remove" },
      },
      required: ["name"],
    },
    handler: handleAgentDisconnect,
  },
  {
    name: "agent_list",
    description: "List the configured diagnostic agents and which one is active.",
    inputSchema: { type: "object", properties: {} },
    handler: handleAgentList,
  },
  {
    name: "diagnostics_mode",
    description:
      "Turn diagnostic traces on or off for subsequent agent_prompt calls, or report the current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["on", "off", "status"], description: "Desired mode" },
      },
      required: ["mode"],
    },
    handler: handleDiagnosticsMode,
  },
  {
    name: "agent_last_trace",
    description: "Show the diagnostic trace of the most recent agent run in this session.",
    inputSchema: { type: "object", properties: {} },
    handler: handleAgentLastTrace,
  },
  {
    name: "agent_report",
    description:
      "Export all diagnostic agent runs from this session as a self-contained HTML report and return the file path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Output path for the .html report (relative paths resolve against the project)",
        },
      },
    },
    handler: handleAgentReport,
  },
  {
    name: "adapter_info",
    description:
      "Show where the bundled Python adapter for Pydantic AI lives and how to install and run it.",
    inputSchema: { type: "object", properties: {} },
    handler: handleAdapterInfo,
  },
  {
    name: "adapter_init",
    description:
      "Write a starter FastAPI bridge file that wires a Pydantic AI agent to the bundled pi-agent-doctor adapter.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Output path for the starter server (defaults to agent_doctor_server.py)",
        },
      },
    },
    handler: handleAdapterInit,
  },
];

async function handleAgentPrompt(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return toolError("agent_prompt requires a non-empty 'prompt'.");
  }

  const agent =
    typeof args.agent === "string" && args.agent.trim()
      ? findAgent(args.agent.trim())
      : getCurrentAgent();
  if (!agent) {
    return toolError(`Unknown agent '${args.agent}'. Use agent_list to see connected agents.`);
  }

  const diagnosticsRequested =
    typeof args.diagnostics === "boolean" ? args.diagnostics : state.diagnosticsEnabled;

  const startedAt = Date.now();
  const events = [];
  let registeredTools = [];
  let finalText = "";
  let error;

  try {
    const parsed = await requestAgent(agent, prompt, diagnosticsRequested, {
      sessionId: process.env.CLAUDE_SESSION_ID,
      onEvent: (event) => events.push(event),
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
  }

  const run = {
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
  state.runs.push(run);

  const message = formatRunMessage(run);
  return error ? toolError(message) : toolText(message);
}

async function handleAgentConnect(args) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const baseUrl = typeof args.baseUrl === "string" ? args.baseUrl.trim() : "";
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return toolError("Agent name must contain only letters, digits, '.', '_' or '-'.");
  }
  const urlError = validateBaseUrl(baseUrl);
  if (urlError) {
    return toolError(urlError);
  }

  const index = state.agents.findIndex((candidate) => candidate.name === name);
  if (index >= 0) {
    state.agents[index] = { name, baseUrl };
  } else {
    state.agents.push({ name, baseUrl });
  }
  state.currentAgentName = name;
  await persistConfig();
  return toolText(`Connected '${name}' -> ${baseUrl}. It is now the active diagnostic agent.`);
}

async function handleAgentUse(args) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const agent = findAgent(name);
  if (!agent) {
    return toolError(`Unknown agent '${name}'. Use agent_list to see connected agents.`);
  }
  state.currentAgentName = agent.name;
  await persistConfig();
  return toolText(`Using diagnostic agent '${agent.name}' (${agent.baseUrl}).`);
}

async function handleAgentDisconnect(args) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (name === "default") {
    return toolError(
      "The default agent cannot be removed; reconnect it with agent_connect instead.",
    );
  }
  const before = state.agents.length;
  state.agents = state.agents.filter((agent) => agent.name !== name);
  if (state.agents.length === before) {
    return toolError(`Unknown agent '${name}'.`);
  }
  if (state.currentAgentName === name) {
    state.currentAgentName = state.agents[0]?.name ?? "default";
  }
  await persistConfig();
  return toolText(`Removed diagnostic agent '${name}'. Active agent: ${state.currentAgentName}.`);
}

async function handleAgentList() {
  const lines = state.agents.map((agent) => {
    const marker = agent.name === state.currentAgentName ? "*" : " ";
    return `${marker} ${agent.name} -> ${agent.baseUrl}`;
  });
  lines.push("", `Diagnostics: ${state.diagnosticsEnabled ? "on" : "off"}`);
  return toolText(lines.join("\n"));
}

async function handleDiagnosticsMode(args) {
  const mode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
  if (mode === "on") {
    state.diagnosticsEnabled = true;
  } else if (mode === "off") {
    state.diagnosticsEnabled = false;
  } else if (mode !== "status") {
    return toolError("diagnostics_mode requires mode 'on', 'off', or 'status'.");
  }
  await persistConfig();
  return toolText(
    `Diagnostics are ${state.diagnosticsEnabled ? "on" : "off"}. Active agent: ${state.currentAgentName}.`,
  );
}

async function handleAgentLastTrace() {
  const run = state.runs[state.runs.length - 1];
  if (!run) {
    return toolError("No diagnostic agent run has completed in this session yet.");
  }
  const lines = [
    `Trace for ${run.agentName} (${new Date(run.completedAt).toISOString()})`,
    `Prompt: ${run.prompt}`,
    "",
    ...formatEventsMarkdown(run.events),
  ];
  return toolText(lines.join("\n"));
}

async function handleAgentReport(args) {
  if (state.runs.length === 0) {
    return toolError("No diagnostic agent runs recorded in this session yet.");
  }
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  const outputPath = resolveReportPath(workingDir, requestedPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderHtmlReport(state.runs), "utf8");
  return toolText(`Wrote diagnostic report with ${state.runs.length} run(s): ${outputPath}`);
}

async function handleAdapterInfo() {
  const exists = existsSync(builtinPythonAdapterDir);
  const status = exists ? "available" : "missing";
  const message = [
    `Built-in Pydantic AI adapter: ${status}`,
    `Path: ${builtinPythonAdapterDir}`,
    "",
    "Install the Python dependencies if needed:",
    `  pip install -e ${JSON.stringify(`${builtinPythonAdapterDir}[server]`)}`,
    "",
    "Create a starter server in this project with the adapter_init tool, then run:",
    "  uvicorn agent_doctor_server:app --host 127.0.0.1 --port 8765",
    "",
    "Connect it:",
    "  agent_connect name=default baseUrl=http://127.0.0.1:8765",
  ].join("\n");
  return exists ? toolText(message) : toolError(message);
}

async function handleAdapterInit(args) {
  if (!existsSync(builtinPythonAdapterDir)) {
    return toolError(
      `Bundled adapter directory was not found at ${builtinPythonAdapterDir}. Reinstall pi-agent-doctor.`,
    );
  }
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  const outputPath = resolveAdapterStarterPath(workingDir, requestedPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderAdapterStarter(builtinPythonAdapterDir), "utf8");
  return toolText(
    [
      `Wrote ${outputPath}`,
      `Run it with: uvicorn ${path.basename(outputPath, ".py")}:app --host 127.0.0.1 --port 8765`,
    ].join("\n"),
  );
}

function findAgent(name) {
  return state.agents.find((agent) => agent.name === name);
}

function getCurrentAgent() {
  return (
    findAgent(state.currentAgentName) ??
    state.agents[0] ?? { name: "default", baseUrl: defaultAgentUrl }
  );
}

async function loadPersistedConfig() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return;
  if (Array.isArray(parsed.agents)) {
    const agents = parsed.agents.filter(
      (agent) => isRecord(agent) && typeof agent.name === "string" && typeof agent.baseUrl === "string",
    );
    if (agents.length > 0) state.agents = agents;
  }
  if (typeof parsed.currentAgentName === "string" && findAgent(parsed.currentAgentName)) {
    state.currentAgentName = parsed.currentAgentName;
  }
  if (typeof parsed.diagnosticsEnabled === "boolean") {
    state.diagnosticsEnabled = parsed.diagnosticsEnabled;
  }
  // A fresh PYDANTIC_AGENT_URL always wins over a stale persisted default.
  if (process.env.PYDANTIC_AGENT_URL) {
    const index = state.agents.findIndex((agent) => agent.name === "default");
    const entry = { name: "default", baseUrl: process.env.PYDANTIC_AGENT_URL };
    if (index >= 0) {
      state.agents[index] = entry;
    } else {
      state.agents.unshift(entry);
    }
  }
}

async function persistConfig() {
  try {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          version: 1,
          agents: state.agents,
          currentAgentName: state.currentAgentName,
          diagnosticsEnabled: state.diagnosticsEnabled,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Persistence is best-effort; the in-memory state still works.
  }
}

function toolText(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// --- JSON-RPC 2.0 over stdio (newline-delimited) ---

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(request) {
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested = isRecord(params) ? params.protocolVersion : undefined;
      sendResult(id, {
        protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return;
    case "ping":
      if (!isNotification) sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
      return;
    case "tools/call": {
      const name = isRecord(params) ? params.name : undefined;
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        sendError(id, -32602, `Unknown tool: ${String(name)}`);
        return;
      }
      const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {};
      try {
        sendResult(id, await tool.handler(args));
      } catch (caught) {
        sendResult(id, toolError(getErrorMessage(caught)));
      }
      return;
    }
    default:
      if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
  }
}

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineIndex = inputBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (line) {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        sendError(null, -32700, "Parse error");
        request = undefined;
      }
      if (isRecord(request) && typeof request.method === "string") {
        void handleRequest(request);
      }
    }
    newlineIndex = inputBuffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
