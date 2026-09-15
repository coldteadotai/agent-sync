import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { classifyMcpServer, isSensitiveKey, type JsonValue } from "./classify.js";
import type { Diagnostic, ExcludedPath, ScanItem, ScanReport, Scope } from "./types.js";

const MAX_CONFIG_FILE_BYTES = 512 * 1024;

export const OPENCODE_PORTABLE_SETTINGS_KEYS = ["model", "theme"] as const;

export interface OpencodeScanOptions {
  configDir?: string;
  dataDir?: string;
  projectDir?: string | null;
}

export function scanOpencode(options: OpencodeScanOptions = {}): ScanReport {
  const configDir =
    options.configDir ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
  const dataDir =
    options.dataDir ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
  const projectDir = options.projectDir === undefined ? process.cwd() : options.projectDir;

  const items: ScanItem[] = [];
  const excluded: ExcludedPath[] = [];
  const diagnostics: Diagnostic[] = [];

  // OpenCode loads one config file, so scanning both would double-report;
  // .json wins when both exist.
  const userConfig = firstExisting(configDir, ["opencode.json", "opencode.jsonc"]);
  if (userConfig !== null) scanOpencodeConfig(userConfig, "user", items, diagnostics);
  scanMarkdownDirectory(join(configDir, "commands"), "user", "command", items);
  scanPluginsDirectory(join(configDir, "plugins"), "user", items);
  scanNpmPlugins(join(configDir, "package.json"), "user", items, diagnostics);

  for (const exclusion of [
    { path: join(dataDir, "auth.json"), reason: "Credentials never sync." },
    { path: join(dataDir, "storage"), reason: "Session state never syncs." },
    { path: join(dataDir, "log"), reason: "Logs never sync." },
  ]) {
    if (existsSync(exclusion.path)) excluded.push(exclusion);
  }

  let scannedProjectDir: string | null = null;
  if (projectDir !== null) {
    const projectConfig = firstExisting(projectDir, ["opencode.json", "opencode.jsonc"]);
    if (projectConfig !== null) {
      scannedProjectDir = projectDir;
      scanOpencodeConfig(projectConfig, "project", items, diagnostics);
    }
    for (const directory of ["commands", "command"]) {
      if (scanMarkdownDirectory(join(projectDir, ".opencode", directory), "project", "command", items)) {
        scannedProjectDir = projectDir;
      }
    }
    for (const directory of ["agents", "agent"]) {
      if (scanMarkdownDirectory(join(projectDir, ".opencode", directory), "project", "subagent", items)) {
        scannedProjectDir = projectDir;
      }
    }
    for (const directory of ["plugins", "plugin"]) {
      if (scanPluginsDirectory(join(projectDir, ".opencode", directory), "project", items)) {
        scannedProjectDir = projectDir;
      }
    }
  }

  return {
    agent: "opencode",
    present: existsSync(configDir) || items.length > 0,
    userDir: configDir,
    projectDir: scannedProjectDir,
    items,
    excluded,
    diagnostics,
  };
}

function firstExisting(directory: string, names: string[]): string | null {
  for (const name of names) {
    const path = join(directory, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function scanOpencodeConfig(path: string, scope: Scope, items: ScanItem[], diagnostics: Diagnostic[]): void {
  if (!existsSync(path)) return;
  let config: { [key: string]: JsonValue };
  try {
    if (statSync(path).size > MAX_CONFIG_FILE_BYTES) {
      diagnostics.push({ severity: "warning", message: `${path} exceeds the config size limit; skipped.` });
      return;
    }
    const text = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = JSON.parse(stripJsonc(text));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({ severity: "warning", message: `${path} is not a JSON object; skipped.` });
      return;
    }
    config = parsed as { [key: string]: JsonValue };
  } catch {
    // No parser detail: JSON error messages can embed file content.
    diagnostics.push({ severity: "warning", message: `Could not parse ${path}; skipped.` });
    return;
  }

  const portableKeys = OPENCODE_PORTABLE_SETTINGS_KEYS.filter((key) => key in config && !isSensitiveKey(key));
  if (portableKeys.length > 0) {
    items.push({
      name: `${basename(path)} (${portableKeys.join(", ")})`,
      kind: "settings",
      scope,
      status: "candidate",
      reason: "Preference keys on the portable allowlist; every other key stays behind.",
    });
  }

  for (const mcpKey of ["mcp", "mcpServers", "mcp_servers"]) {
    const servers = config[mcpKey];
    if (servers === null || servers === undefined || typeof servers !== "object" || Array.isArray(servers)) {
      continue;
    }
    for (const [name, server] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
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
    break;
  }

  const plugins = config.plugin ?? config.plugins;
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      if (typeof plugin === "string") {
        items.push({
          name: plugin,
          kind: "plugin",
          scope,
          status: "blocked",
          reason: "Plugins run code; they are never synced.",
        });
      }
    }
  }
}

function scanMarkdownDirectory(
  directory: string,
  scope: Scope,
  kind: "command" | "subagent",
  items: ScanItem[],
): boolean {
  if (!existsSync(directory)) return false;
  let found = false;
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
    try {
      if (statSync(join(directory, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    found = true;
    items.push({
      name: basename(entry, ".md"),
      kind,
      scope,
      status: "candidate",
      reason: kind === "command" ? "Slash command is portable." : "Subagent definition is portable.",
    });
  }
  return found;
}

function scanPluginsDirectory(directory: string, scope: Scope, items: ScanItem[]): boolean {
  if (!existsSync(directory)) return false;
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    return false;
  }
  let found = false;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    found = true;
    items.push({
      name: entry,
      kind: "plugin",
      scope,
      status: "blocked",
      reason: "Plugins run code; they are never synced.",
    });
  }
  return found;
}

function scanNpmPlugins(path: string, scope: Scope, items: ScanItem[], diagnostics: Diagnostic[]): void {
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    diagnostics.push({ severity: "warning", message: `Could not parse ${path}; skipped.` });
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as { dependencies?: JsonValue; devDependencies?: JsonValue };
  for (const dependencies of [record.dependencies, record.devDependencies]) {
    if (dependencies === null || dependencies === undefined || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const name of Object.keys(dependencies).sort()) {
      if (name.startsWith("@opencode-ai/") || name.startsWith("opencode-plugin-")) {
        items.push({
          name,
          kind: "plugin",
          scope,
          status: "blocked",
          reason: "Plugins run code; they are never synced.",
        });
      }
    }
  }
}

// jsonc: strip // and /* */ comments outside strings, then trailing commas.
export function stripJsonc(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inString) {
      result += character;
      if (character === "\\") {
        result += text[index + 1] ?? "";
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    result += character;
  }

  let cleaned = "";
  inString = false;
  for (let index = 0; index < result.length; index += 1) {
    const character = result[index] ?? "";
    if (inString) {
      cleaned += character;
      if (character === "\\") {
        cleaned += result[index + 1] ?? "";
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      cleaned += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < result.length && /\s/.test(result[lookahead] ?? "")) lookahead += 1;
      const next = result[lookahead];
      if (next === "}" || next === "]") continue;
    }
    cleaned += character;
  }
  return cleaned;
}
