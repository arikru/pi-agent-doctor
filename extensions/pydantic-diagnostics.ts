import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatRecentEvents,
  formatRunMessage,
  getErrorMessage,
  isRecord,
  parseRunRecord,
  renderAdapterStarter,
  renderHtmlReport,
  requestAgent,
  resolveAdapterStarterPath,
  resolveReportPath,
  truncate,
  validateBaseUrl,
  type AgentConfig,
  type AgentRunRecord,
  type DiagnosticEvent,
  type RegisteredToolInfo,
} from "../lib/diagnostic-core.js";

const CONFIG_ENTRY = "pydantic-diagnostics-config-v1";
const RUN_ENTRY = "pydantic-diagnostics-run-v1";

interface ExtensionState {
  agents: AgentConfig[];
  currentAgentName: string;
  diagnosticsEnabled: boolean;
  lastRun?: AgentRunRecord;
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
    const parsed = await requestAgent(agent, prompt, diagnosticsRequested, {
      signal: ctx.signal,
      sessionId: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getLeafId(),
      onEvent: (event) => {
        events.push(event);
        if (diagnosticsRequested) {
          liveLines.splice(2, liveLines.length - 2, ...formatRecentEvents(events));
          ctx.ui.setWidget("pydantic-diagnostics-live", liveLines, { placement: "aboveEditor" });
        }
      },
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
  const agents = agentsValue
    .map(parseAgentConfig)
    .filter((agent): agent is AgentConfig => agent !== undefined);
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
