export interface AgentConfig {
  name: string;
  baseUrl: string;
}

export interface DiagnosticEvent {
  type: string;
  text?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  timestamp: number;
  raw: unknown;
}

export interface TraceNode {
  event: DiagnosticEvent;
  children: TraceNode[];
}

export interface RegisteredToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  returnSchema?: unknown;
  takesContext?: boolean;
  sequential?: boolean;
  requiresApproval?: boolean;
  raw?: unknown;
}

export interface AgentRunRecord {
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

export interface ParsedAgentResponse {
  finalText: string;
  events: DiagnosticEvent[];
  registeredTools: RegisteredToolInfo[];
}

export interface RequestAgentOptions {
  signal?: AbortSignal;
  sessionId?: string;
  onEvent?: (event: DiagnosticEvent) => void;
}

export function requestAgent(
  agent: AgentConfig,
  prompt: string,
  diagnosticsRequested: boolean,
  options?: RequestAgentOptions,
): Promise<ParsedAgentResponse>;

export function parseAgentPayload(payload: unknown): ParsedAgentResponse;
export function normalizeEvent(value: unknown): DiagnosticEvent;
export function normalizeRegisteredTool(value: unknown): RegisteredToolInfo | undefined;
export function formatRunMessage(run: AgentRunRecord): string;
export function formatEventsMarkdown(events: DiagnosticEvent[]): string[];
export function formatRecentEvents(events: DiagnosticEvent[]): string[];
export function buildTraceTree(events: DiagnosticEvent[]): TraceNode[];
export function renderHtmlReport(runs: AgentRunRecord[]): string;
export function parseRunRecord(value: unknown): AgentRunRecord | undefined;
export function validateBaseUrl(baseUrl: string): string | undefined;
export function resolvePromptUrl(baseUrl: string): string;
export function resolveHealthUrl(promptUrl: string): string;
export function resolveReportPath(cwd: string, requestedPath: string): string;
export function resolveAdapterStarterPath(cwd: string, requestedPath: string): string;
export function renderAdapterStarter(adapterDir: string): string;
export function stringifyForDisplay(value: unknown, maxLength?: number): string;
export function truncate(text: string, maxLength: number): string;
export function getErrorMessage(value: unknown): string;
export function isRecord(value: unknown): value is Record<string, unknown>;
