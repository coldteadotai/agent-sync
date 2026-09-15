import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyMcpServer, isSensitiveKey, type JsonValue } from "./classify.js";
import { parseToml } from "./toml.js";
import type { Diagnostic, ExcludedPath, ScanItem, ScanReport, Scope } from "./types.js";

const MAX_CONFIG_FILE_BYTES = 512 * 1024;

export const CODEX_PORTABLE_SETTINGS_KEYS = ["model", "model_reasoning_effort"] as const;

const CODEX_EXCLUSIONS: ReadonlyArray<{ segment: string; reason: string }> = [
  { segment: "auth.json", reason: "Credentials never sync." },
  { segment: "sessions", reason: "Session history never syncs." },
  { segment: "history.jsonl", reason: "Session history never syncs." },
  { segment: "log", reason: "Logs never sync." },
];

export interface CodexScanOptions {
  codexHome?: string;
  agentsDir?: string;
  projectDir?: string | null;
}

export function scanCodex(options: CodexScanOptions = {}): ScanReport {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const agentsDir = options.agentsDir ?? join(homedir(), ".agents");
  const projectDir = options.projectDir === undefined ? process.cwd() : options.projectDir;

  const items: ScanItem[] = [];
  const excluded: ExcludedPath[] = [];
  const diagnostics: Diagnostic[] = [];

  scanConfigToml(join(codexHome, "config.toml"), "user", items, diagnostics);
  if (existsSync(join(codexHome, "AGENTS.md"))) {
    items.push({ name: "AGENTS.md", kind: "memory", scope: "user", status: "candidate", reason: "Memory file is portable." });
  }
  scanSkillsDirectory(join(agentsDir, "skills"), "user", items, diagnostics);
  for (const exclusion of CODEX_EXCLUSIONS) {
    const path = join(codexHome, exclusion.segment);
    if (existsSync(path)) excluded.push({ path, reason: exclusion.reason });
  }

  let scannedProjectDir: string | null = null;
  if (projectDir !== null) {
    const projectConfig = join(projectDir, ".codex", "config.toml");
    if (existsSync(projectConfig)) {
      scannedProjectDir = projectDir;
      scanConfigToml(projectConfig, "project", items, diagnostics);
    }
    const projectSkills = join(projectDir, ".agents", "skills");
    if (existsSync(projectSkills)) {
      scannedProjectDir = projectDir;
      scanSkillsDirectory(projectSkills, "project", items, diagnostics);
    }
    if (existsSync(join(projectDir, "AGENTS.md"))) {
      scannedProjectDir = projectDir;
      items.push({ name: "AGENTS.md", kind: "memory", scope: "project", status: "candidate", reason: "Memory file is portable." });
    }
  }

  return {
    agent: "codex",
    present: existsSync(codexHome) || items.length > 0,
    userDir: codexHome,
    projectDir: scannedProjectDir,
    items,
    excluded,
    diagnostics,
  };
}

function scanConfigToml(path: string, scope: Scope, items: ScanItem[], diagnostics: Diagnostic[]): void {
  if (!existsSync(path)) return;
  let config: { [key: string]: JsonValue };
  try {
    if (statSync(path).size > MAX_CONFIG_FILE_BYTES) {
      diagnostics.push({ severity: "warning", message: `${path} exceeds the config size limit; skipped.` });
      return;
    }
    config = parseToml(readFileSync(path, "utf8"));
  } catch (error) {
    // Enforced locally, not just via the parser's own discipline: only a
    // message matching the parser's fixed shape is passed through.
    const detail =
      error instanceof Error && /^toml line \d+: [A-Za-z .,()=-]+\.$/.test(error.message)
        ? error.message
        : "invalid TOML";
    diagnostics.push({ severity: "warning", message: `Could not parse ${path}: ${detail}` });
    return;
  }

  const portableKeys = CODEX_PORTABLE_SETTINGS_KEYS.filter((key) => key in config && !isSensitiveKey(key));
  if (portableKeys.length > 0) {
    items.push({
      name: `config.toml (${portableKeys.join(", ")})`,
      kind: "settings",
      scope,
      status: "candidate",
      reason: "Preference keys on the portable allowlist; every other key stays behind.",
    });
  }

  const servers = config.mcp_servers ?? config.mcpServers;
  if (servers !== null && servers !== undefined && typeof servers === "object" && !Array.isArray(servers)) {
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
  }
}

function scanSkillsDirectory(directory: string, scope: Scope, items: ScanItem[], diagnostics: Diagnostic[]): void {
  if (!existsSync(directory)) return;
  let entries: string[];
  try {
    entries = statSync(directory).isDirectory() ? readdirSync(directory).sort() : [];
  } catch (error) {
    diagnostics.push({
      severity: "error",
      message: `Could not read ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const skillPath = join(directory, entry);
    try {
      if (!statSync(skillPath).isDirectory() || !existsSync(join(skillPath, "SKILL.md"))) continue;
    } catch {
      continue;
    }
    items.push({ name: entry, kind: "skill", scope, status: "candidate", reason: "Skill directory is portable." });
  }
}
