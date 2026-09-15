export type Scope = "user" | "project";

export type SyncStatus = "candidate" | "needs_secret" | "blocked" | "unsupported";

export type ItemKind = "skill" | "subagent" | "command" | "memory" | "settings" | "hook" | "mcp_server";

export interface ScanItem {
  name: string;
  kind: ItemKind;
  scope: Scope;
  status: SyncStatus;
  reason: string;
  envRefs?: string[];
  url?: string;
  transport?: "http" | "sse";
}

export interface ExcludedPath {
  path: string;
  reason: string;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
}

export interface ScanReport {
  agent: "claude-code";
  userDir: string;
  projectDir: string | null;
  items: ScanItem[];
  excluded: ExcludedPath[];
  diagnostics: Diagnostic[];
}
