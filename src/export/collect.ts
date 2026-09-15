import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSensitiveKey, type JsonValue } from "../scan/classify.js";
import { isRepresentableTreePath } from "./tar.js";
import { PORTABLE_SETTINGS_KEYS, scanClaudeCode } from "../scan/scanner.js";
import type { Diagnostic, ScanItem } from "../scan/types.js";

export const MANIFEST_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// Files matching these never enter a bundle, even inside a skill directory.
const CREDENTIAL_FILE_PATTERNS = [
  /^\.env(\..*)?$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.ppk$/i,
  /^id_[a-z0-9_.-]+$/i,
  /^\.credentials\.json$/,
];

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  executable?: boolean;
}

export interface ManifestMcpServer {
  name: string;
  status: string;
  reason: string;
  envRefs?: string[];
}

export interface ManifestHook {
  name: string;
  included: boolean;
}

export interface Manifest {
  schemaVersion: number;
  tool: "agent-sync";
  agent: "claude-code";
  files: ManifestFile[];
  mcpServers: ManifestMcpServer[];
  hooks: ManifestHook[];
}

export interface BundleEntry {
  path: string;
  content: Buffer;
  executable: boolean;
}

export interface ExportPlan {
  manifest: Manifest;
  entries: BundleEntry[];
  skipped: { path: string; reason: string }[];
  diagnostics: Diagnostic[];
}

export interface CollectOptions {
  userDir?: string;
  claudeJsonPath?: string;
  confirmedHooks?: string[];
}

export function collectExport(options: CollectOptions = {}): ExportPlan {
  const userDir = options.userDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const confirmedHooks = options.confirmedHooks ?? [];

  const scanOptions: Parameters<typeof scanClaudeCode>[0] = { userDir, projectDir: null };
  if (options.claudeJsonPath !== undefined) scanOptions.claudeJsonPath = options.claudeJsonPath;
  const report = scanClaudeCode(scanOptions);

  const entries: BundleEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const diagnostics: Diagnostic[] = [...report.diagnostics];
  let totalBytes = 0;

  const addFile = (bundlePath: string, content: Buffer, executable: boolean): void => {
    if (!isRepresentableTreePath(`files/${bundlePath}`)) {
      skipped.push({ path: bundlePath, reason: "path too long for a tar archive" });
      return;
    }
    if (content.length > MAX_FILE_BYTES) {
      skipped.push({ path: bundlePath, reason: `larger than the ${MAX_FILE_BYTES} byte per-file limit` });
      return;
    }
    if (totalBytes + content.length > MAX_TOTAL_BYTES) {
      skipped.push({ path: bundlePath, reason: `would exceed the ${MAX_TOTAL_BYTES} byte bundle limit` });
      return;
    }
    totalBytes += content.length;
    entries.push({ path: bundlePath, content, executable });
  };

  const userItems = report.items.filter((item) => item.scope === "user");
  for (const item of userItems) {
    if (item.status !== "candidate") continue;
    if (item.kind === "skill") {
      collectTree(join(userDir, "skills", item.name), `skills/${item.name}`, addFile, skipped);
    } else if (item.kind === "subagent") {
      collectRegularFile(join(userDir, "agents", `${item.name}.md`), `agents/${item.name}.md`, addFile, skipped);
    } else if (item.kind === "command") {
      collectRegularFile(join(userDir, "commands", `${item.name}.md`), `commands/${item.name}.md`, addFile, skipped);
    } else if (item.kind === "memory") {
      collectRegularFile(join(userDir, "CLAUDE.md"), "CLAUDE.md", addFile, skipped);
    }
  }

  const hookItems = userItems.filter((item) => item.kind === "hook");
  const hookNames = new Set(hookItems.map((item) => item.name));
  for (const requested of confirmedHooks) {
    if (!hookNames.has(requested)) {
      diagnostics.push({ severity: "error", message: `--hook ${requested} does not match any scanned hook.` });
    }
  }
  const included = new Set(confirmedHooks.filter((name) => hookNames.has(name)));

  const settingsContent = buildPortableSettings(join(userDir, "settings.json"), included, diagnostics);
  if (settingsContent !== null) addFile("settings.json", settingsContent, false);

  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: "agent-sync",
    agent: "claude-code",
    files: entries
      .map((entry) => {
        const file: ManifestFile = {
          path: entry.path,
          sha256: createHash("sha256").update(entry.content).digest("hex"),
          size: entry.content.length,
        };
        if (entry.executable) file.executable = true;
        return file;
      })
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    mcpServers: userItems
      .filter((item) => item.kind === "mcp_server")
      .map((item) => toManifestServer(item)),
    hooks: hookItems.map((item) => ({ name: item.name, included: included.has(item.name) })),
  };

  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { manifest, entries, skipped, diagnostics };
}

function toManifestServer(item: ScanItem): ManifestMcpServer {
  const server: ManifestMcpServer = { name: item.name, status: item.status, reason: item.reason };
  if (item.envRefs !== undefined && item.envRefs.length > 0) server.envRefs = item.envRefs;
  return server;
}

function collectTree(
  root: string,
  bundleRoot: string,
  addFile: (bundlePath: string, content: Buffer, executable: boolean) => void,
  skipped: { path: string; reason: string }[],
): void {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    skipped.push({ path: bundleRoot, reason: "unreadable directory" });
    return;
  }
  for (const name of names) {
    if (name.startsWith(".") && !/^\.env(\..*)?$/.test(name)) continue;
    const sourcePath = join(root, name);
    const bundlePath = `${bundleRoot}/${name}`;
    if (CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(name))) {
      skipped.push({ path: bundlePath, reason: "credential-pattern filename" });
      continue;
    }
    const stat = lstatSync(sourcePath, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isSymbolicLink()) {
      // A symlink inside a skill directory could point anywhere on disk.
      skipped.push({ path: bundlePath, reason: "symlink" });
      continue;
    }
    if (stat.isDirectory()) {
      collectTree(sourcePath, bundlePath, addFile, skipped);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: bundlePath, reason: "not a regular file" });
      continue;
    }
    addFile(bundlePath, readFileSync(sourcePath), (stat.mode & 0o100) !== 0);
  }
}

function collectRegularFile(
  sourcePath: string,
  bundlePath: string,
  addFile: (bundlePath: string, content: Buffer, executable: boolean) => void,
  skipped: { path: string; reason: string }[],
): void {
  const stat = lstatSync(sourcePath, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (!stat.isFile()) {
    skipped.push({ path: bundlePath, reason: stat.isSymbolicLink() ? "symlink" : "not a regular file" });
    return;
  }
  addFile(bundlePath, readFileSync(sourcePath), (stat.mode & 0o100) !== 0);
}

function buildPortableSettings(
  settingsPath: string,
  includedHooks: Set<string>,
  diagnostics: Diagnostic[],
): Buffer | null {
  if (!existsSync(settingsPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    diagnostics.push({ severity: "warning", message: `${settingsPath} could not be parsed; settings were not exported.` });
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as { [key: string]: JsonValue };

  const portable: { [key: string]: JsonValue } = {};
  for (const key of PORTABLE_SETTINGS_KEYS) {
    if (key in source && !isSensitiveKey(key)) portable[key] = source[key] as JsonValue;
  }
  if (includedHooks.has("settings.statusLine") && "statusLine" in source) {
    portable.statusLine = source.statusLine as JsonValue;
  }
  const hooks = source.hooks;
  if (hooks !== null && hooks !== undefined && typeof hooks === "object" && !Array.isArray(hooks)) {
    const confirmed: { [key: string]: JsonValue } = {};
    for (const [event, config] of Object.entries(hooks)) {
      if (includedHooks.has(`hooks.${event}`)) confirmed[event] = config;
    }
    if (Object.keys(confirmed).length > 0) portable.hooks = confirmed;
  }

  if (Object.keys(portable).length === 0) return null;
  const ordered = Object.fromEntries(Object.entries(portable).sort(([a], [b]) => (a < b ? -1 : 1)));
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}
