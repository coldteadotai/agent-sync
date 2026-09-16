import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { classifyMcpServer, isSensitiveKey, type JsonValue } from "./classify.js";
import type { Diagnostic, ExcludedPath, ScanItem, ScanReport, Scope } from "./types.js";

// Config files stay small; ~/.claude.json also carries per-project history and grows to megabytes.
const MAX_CONFIG_FILE_BYTES = 512 * 1024;
const MAX_CLAUDE_JSON_BYTES = 20 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;

export const PORTABLE_SETTINGS_KEYS = [
  "alwaysThinkingEnabled",
  "editorMode",
  "effortLevel",
  "language",
  "model",
  "outputStyle",
  "theme",
] as const;

const USER_EXCLUSIONS: ReadonlyArray<{ segment: string; reason: string }> = [
  { segment: ".credentials.json", reason: "Credentials never sync." },
  { segment: "history.jsonl", reason: "Session history never syncs." },
  { segment: "projects", reason: "Session transcripts never sync." },
  { segment: "todos", reason: "Session state never syncs." },
  { segment: "shell-snapshots", reason: "Machine state never syncs." },
  { segment: "statsig", reason: "Caches never sync." },
  { segment: "cache", reason: "Caches never sync." },
];

export interface ScanOptions {
  userDir?: string;
  projectDir?: string | null;
  claudeJsonPath?: string;
}

export function scanClaudeCode(options: ScanOptions = {}): ScanReport {
  const configDirOverride = process.env.CLAUDE_CONFIG_DIR;
  const userDir = options.userDir ?? configDirOverride ?? join(homedir(), ".claude");
  const projectDir = options.projectDir === undefined ? process.cwd() : options.projectDir;
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside that directory.
  const claudeJsonPath =
    options.claudeJsonPath ??
    (configDirOverride !== undefined
      ? join(configDirOverride, ".claude.json")
      : join(homedir(), ".claude.json"));

  const items: ScanItem[] = [];
  const excluded: ExcludedPath[] = [];
  const diagnostics: Diagnostic[] = [];

  scanScope(userDir, "user", items, diagnostics);
  addMemory(join(userDir, "CLAUDE.md"), "user", items);
  for (const exclusion of USER_EXCLUSIONS) {
    const path = join(userDir, exclusion.segment);
    if (existsSync(path)) excluded.push({ path, reason: exclusion.reason });
  }

  if (existsSync(claudeJsonPath)) {
    excluded.push({
      path: claudeJsonPath,
      reason: "Holds OAuth state, credentials and history; MCP entries below are read from it as names only.",
    });
    scanMcpConfig(claudeJsonPath, "user", MAX_CLAUDE_JSON_BYTES, items, diagnostics, {
      includeProjectNested: true,
    });
  }

  let scannedProjectDir: string | null = null;
  if (projectDir !== null && !existsSync(projectDir)) {
    diagnostics.push({
      severity: "warning",
      message: `Project directory ${projectDir} does not exist; project scope was not scanned.`,
    });
  }
  if (projectDir !== null && existsSync(join(projectDir, ".claude"))) {
    scannedProjectDir = projectDir;
    scanScope(join(projectDir, ".claude"), "project", items, diagnostics);
    const localSettings = join(projectDir, ".claude", "settings.local.json");
    if (existsSync(localSettings)) {
      excluded.push({ path: localSettings, reason: "Machine-local overrides never sync." });
    }
  }
  if (projectDir !== null && addMemory(join(projectDir, "CLAUDE.md"), "project", items)) {
    scannedProjectDir = projectDir;
  }
  const projectMcp = projectDir === null ? null : join(projectDir, ".mcp.json");
  if (projectMcp !== null && existsSync(projectMcp)) {
    scannedProjectDir = projectDir;
    scanMcpConfig(projectMcp, "project", MAX_CONFIG_FILE_BYTES, items, diagnostics);
  }

  return {
    agent: "claude-code",
    present: existsSync(userDir) || existsSync(claudeJsonPath) || items.length > 0,
    userDir,
    projectDir: scannedProjectDir,
    items,
    excluded,
    diagnostics,
  };
}

function scanScope(configDir: string, scope: Scope, items: ScanItem[], diagnostics: Diagnostic[]): void {
  scanEntryDirectory(join(configDir, "skills"), scope, "skill", items, diagnostics);
  scanEntryDirectory(join(configDir, "agents"), scope, "subagent", items, diagnostics);
  scanEntryDirectory(join(configDir, "commands"), scope, "command", items, diagnostics);

  scanSettingsFile(join(configDir, "settings.json"), scope, items, diagnostics);
}

function addMemory(path: string, scope: Scope, items: ScanItem[]): boolean {
  if (!existsSync(path)) return false;
  items.push({
    name: "CLAUDE.md",
    kind: "memory",
    scope,
    status: "candidate",
    reason: "Memory file is portable.",
  });
  return true;
}

function scanEntryDirectory(
  directory: string,
  scope: Scope,
  kind: "skill" | "subagent" | "command",
  items: ScanItem[],
  diagnostics: Diagnostic[],
): void {
  if (!existsSync(directory)) return;
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch (error) {
    diagnostics.push({ severity: "error", message: `Could not read ${directory}: ${describe(error)}` });
    return;
  }

  let counted = 0;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(directory, entry);
    const name = entryName(kind, path, entry);
    if (name === null) continue;
    if (counted >= MAX_DIRECTORY_ENTRIES) {
      diagnostics.push({
        severity: "warning",
        message: `${directory} has more than ${MAX_DIRECTORY_ENTRIES} entries; the rest were not listed.`,
      });
      break;
    }
    counted += 1;
    items.push({ name, kind, scope, status: "candidate", reason: portableReason(kind) });
  }
}

function entryName(kind: "skill" | "subagent" | "command", path: string, entry: string): string | null {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    return null;
  }
  if (kind === "skill") {
    if (!isDirectory || !existsSync(join(path, "SKILL.md"))) return null;
    return entry;
  }
  if (isDirectory || !entry.endsWith(".md")) return null;
  return basename(entry, ".md");
}

function portableReason(kind: "skill" | "subagent" | "command"): string {
  if (kind === "skill") return "Skill directory is portable.";
  if (kind === "subagent") return "Subagent definition is portable.";
  return "Slash command is portable.";
}

function scanSettingsFile(path: string, scope: Scope, items: ScanItem[], diagnostics: Diagnostic[]): void {
  const settings = readJsonObject(path, MAX_CONFIG_FILE_BYTES, diagnostics);
  if (settings === null) return;

  const portableKeys = PORTABLE_SETTINGS_KEYS.filter(
    (key) => key in settings && !isSensitiveKey(key),
  );
  if (portableKeys.length > 0) {
    items.push({
      name: `settings.json (${portableKeys.join(", ")})`,
      kind: "settings",
      scope,
      status: "candidate",
      reason: "Preference keys on the portable allowlist; every other key stays behind.",
    });
  }

  // statusLine.command and every hook run arbitrary shell on the target machine.
  if ("statusLine" in settings) {
    const item: ScanItem = {
      name: "settings.statusLine",
      kind: "hook",
      scope,
      status: "blocked",
      reason: "Runs a shell command; syncs only after explicit confirmation during export.",
    };
    const command = commandSummary([settings.statusLine ?? null]);
    if (command !== null) item.detail = command;
    items.push(item);
  }
  const hooks = settings.hooks;
  if (hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)) {
    for (const event of Object.keys(hooks).sort()) {
      const item: ScanItem = {
        name: `hooks.${event}`,
        kind: "hook",
        scope,
        status: "blocked",
        reason: "Hooks are shell commands; each syncs only after explicit confirmation during export.",
      };
      const command = commandSummary([hooks[event] ?? null]);
      if (command !== null) item.detail = command;
      items.push(item);
    }
  }

  // Plugins are declarative name@marketplace references: only the name and the
  // marketplace source ever travel, never plugin code.
  const enabled = asObject(settings.enabledPlugins ?? null);
  if (enabled !== null) {
    const marketplaces = asObject(settings.extraKnownMarketplaces ?? null);
    for (const name of Object.keys(enabled).sort()) {
      if (enabled[name] !== true) continue;
      const item: ScanItem = {
        name,
        kind: "plugin",
        scope,
        status: "candidate",
        reason: "Declarative plugin reference; re-installed by name on the target, code never travels.",
      };
      const marketplaceName = name.split("@")[1];
      const source =
        marketplaceName !== undefined && marketplaces !== null
          ? marketplaceSummary(marketplaces[marketplaceName] ?? null)
          : null;
      if (source !== null) item.detail = source;
      items.push(item);
    }
  }
}

// Digs the first "command" string out of a hook/statusLine config for display.
function commandSummary(values: (JsonValue | undefined)[]): string | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") return truncateDetail(value);
    if (Array.isArray(value)) {
      const found = commandSummary(value);
      if (found !== null) return found;
      continue;
    }
    if (typeof value === "object") {
      const record = value;
      if (typeof record.command === "string") return truncateDetail(record.command);
      const found = commandSummary(Object.values(record));
      if (found !== null) return found;
    }
  }
  return null;
}

function marketplaceSummary(value: JsonValue | null): string | null {
  const record = asObject(value);
  if (record === null) return null;
  const source = asObject(record.source ?? null);
  if (source === null) return null;
  for (const key of ["repo", "url", "path"]) {
    const candidate = source[key];
    if (typeof candidate === "string") return truncateDetail(candidate);
  }
  return null;
}

function truncateDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function scanMcpConfig(
  path: string,
  scope: Scope,
  maxBytes: number,
  items: ScanItem[],
  diagnostics: Diagnostic[],
  options: { includeProjectNested: boolean } = { includeProjectNested: false },
): void {
  const config = readJsonObject(path, maxBytes, diagnostics);
  if (config === null) return;

  const servers = new Map<string, JsonValue>();
  collectServers(config.mcpServers ?? config.mcp_servers, servers);

  // `claude mcp add` defaults to local scope, which nests servers under
  // projects["<dir>"].mcpServers inside ~/.claude.json.
  if (options.includeProjectNested) {
    const projects = asObject(config.projects);
    if (projects !== null) {
      for (const key of Object.keys(projects).sort()) {
        const projectEntry = asObject(projects[key] ?? null);
        if (projectEntry !== null) {
          collectServers(projectEntry.mcpServers ?? projectEntry.mcp_servers, servers);
        }
      }
    }
  }

  for (const [name, server] of [...servers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const classification = classifyMcpServer(server);
    const item: ScanItem = {
      name,
      kind: "mcp_server",
      scope,
      status: classification.status,
      reason: classification.reason,
    };
    if (classification.envRefs.length > 0) item.envRefs = classification.envRefs;
    if (classification.url !== undefined) {
      item.url = classification.url;
      item.transport = classification.transport ?? "http";
    }
    items.push(item);
  }
}

function collectServers(value: JsonValue | undefined, servers: Map<string, JsonValue>): void {
  const record = value === undefined ? null : asObject(value);
  if (record === null) return;
  for (const [name, server] of Object.entries(record)) {
    if (!servers.has(name)) servers.set(name, server);
  }
}

function asObject(value: JsonValue | null | undefined): { [key: string]: JsonValue } | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function readJsonObject(
  path: string,
  maxBytes: number,
  diagnostics: Diagnostic[],
): { [key: string]: JsonValue } | null {
  if (!existsSync(path)) return null;
  try {
    const size = statSync(path).size;
    if (size > maxBytes) {
      diagnostics.push({
        severity: "warning",
        message: `${path} is ${size} bytes (limit ${maxBytes}); skipped.`,
      });
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({ severity: "warning", message: `${path} is not a JSON object; skipped.` });
      return null;
    }
    return parsed as { [key: string]: JsonValue };
  } catch (error) {
    // V8's SyntaxError messages embed raw source excerpts, which would leak file
    // content into the report; keep only the position, never the message.
    const detail =
      error instanceof SyntaxError
        ? (error.message.match(/at position \d+(?: \(line \d+ column \d+\))?/)?.[0] ?? "invalid JSON")
        : describe(error);
    diagnostics.push({ severity: "warning", message: `Could not parse ${path}: ${detail}` });
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
