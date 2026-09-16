import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSensitiveKey, type JsonValue } from "../scan/classify.js";
import { scanContentForSecrets } from "./secrets.js";
import { isRepresentableTreePath } from "./tar.js";
import { PORTABLE_SETTINGS_KEYS, scanClaudeCode } from "../scan/scanner.js";
import type { Diagnostic, ScanItem } from "../scan/types.js";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// Files matching these never enter a bundle, even inside a skill directory.
// Every pattern is case-insensitive: targets may sit on case-insensitive
// filesystems, where ".ENV" writes over ".env".
export const CREDENTIAL_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.ppk$/i,
  /^id_[a-z0-9_.-]+$/i,
  /^\.credentials\.json$/i,
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
  url?: string;
  transport?: "http" | "sse";
}

export interface ManifestHook {
  name: string;
  included: boolean;
}

export interface ManifestPlugin {
  name: string;
  included: boolean;
  marketplace?: string;
}

export interface Manifest {
  schemaVersion: number;
  tool: "agent-sync";
  agent: "claude-code";
  files: ManifestFile[];
  mcpServers: ManifestMcpServer[];
  hooks: ManifestHook[];
  // Additive since 0.2; older applies ignore it, so schemaVersion stays 1.
  // NOTE: that reasoning no longer extends to settings keys. The receive side
  // refuses settings.json keys it does not know (assertPortableSettings), so
  // adding a portable key means older applies refuse newer bundles — bump the
  // manifest schema when adding one.
  plugins?: ManifestPlugin[];
}

export interface BundleEntry {
  path: string;
  content: Buffer;
  executable: boolean;
}

export interface SecretPathFinding {
  path: string;
  line: number;
  kind: string;
}

export interface ExportPlan {
  manifest: Manifest;
  entries: BundleEntry[];
  skipped: { path: string; reason: string }[];
  secretFindings: SecretPathFinding[];
  diagnostics: Diagnostic[];
}

export interface CollectOptions {
  userDir?: string;
  claudeJsonPath?: string;
  confirmedHooks?: string[];
  selectedPlugins?: string[];
  skips?: string[];
  allowSecrets?: string[];
}

// The flag spelling of a picker row: "skill/boxd-cli", "memory/CLAUDE.md", "settings".
export function skipToken(item: Pick<ScanItem, "kind" | "name">): string {
  return item.kind === "settings" ? "settings" : `${item.kind}/${item.name}`;
}

export function collectExport(options: CollectOptions = {}): ExportPlan {
  const userDir = options.userDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const confirmedHooks = options.confirmedHooks ?? [];
  const selectedPlugins = options.selectedPlugins ?? [];
  const skips = new Set(options.skips ?? []);
  const allowSecrets = new Set(options.allowSecrets ?? []);

  const scanOptions: Parameters<typeof scanClaudeCode>[0] = { userDir, projectDir: null };
  if (options.claudeJsonPath !== undefined) scanOptions.claudeJsonPath = options.claudeJsonPath;
  const report = scanClaudeCode(scanOptions);

  const entries: BundleEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const secretFindings: SecretPathFinding[] = [];
  const diagnostics: Diagnostic[] = [...report.diagnostics];
  let totalBytes = 0;

  const addFile = (bundlePath: string, content: Buffer, executable: boolean): void => {
    if (!isRepresentableTreePath(`files/${bundlePath}`)) {
      skipped.push({ path: bundlePath, reason: "path too long for a tar archive" });
      return;
    }
    // Content that looks like a secret refuses by default; --allow-secret is
    // the named override. The reason names the file and line, never the value.
    const secrets = scanContentForSecrets(content);
    if (secrets.length > 0) {
      const first = secrets[0];
      if (first !== undefined) {
        for (const finding of secrets) secretFindings.push({ path: bundlePath, ...finding });
        if (!allowSecrets.has(bundlePath)) {
          skipped.push({
            path: bundlePath,
            reason: `content matches a ${first.kind} pattern (line ${first.line}); pass --allow-secret ${bundlePath} to carry it anyway`,
          });
          return;
        }
      }
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

  const skippable = new Set(
    userItems
      .filter((item) => item.status === "candidate" && item.kind !== "mcp_server")
      .map((item) => skipToken(item)),
  );
  for (const requested of skips) {
    if (!skippable.has(requested)) {
      diagnostics.push({ severity: "error", message: `--skip ${requested} does not match any scanned item.` });
    }
  }

  for (const item of userItems) {
    if (item.status !== "candidate") continue;
    if (skips.has(skipToken(item))) continue;
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

  const pluginItems = userItems.filter((item) => item.kind === "plugin" && item.status === "candidate");
  const pluginNames = new Set(pluginItems.map((item) => item.name));
  for (const requested of selectedPlugins) {
    if (!pluginNames.has(requested)) {
      diagnostics.push({ severity: "error", message: `--plugin ${requested} does not match any scanned plugin.` });
    }
  }
  const includedPlugins = new Set(selectedPlugins.filter((name) => pluginNames.has(name)));

  const settingsContent = buildPortableSettings(join(userDir, "settings.json"), {
    includePreferences: !skips.has("settings"),
    includedHooks: included,
    includedPlugins,
    diagnostics,
  });
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
  if (pluginItems.length > 0) {
    manifest.plugins = pluginItems.map((item) => {
      const plugin: ManifestPlugin = { name: item.name, included: includedPlugins.has(item.name) };
      if (item.detail !== undefined) plugin.marketplace = item.detail;
      return plugin;
    });
  }

  for (const requested of allowSecrets) {
    if (!secretFindings.some((finding) => finding.path === requested)) {
      diagnostics.push({
        severity: "error",
        message: `--allow-secret ${requested} does not match any file with a secret finding.`,
      });
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { manifest, entries, skipped, secretFindings, diagnostics };
}

function toManifestServer(item: ScanItem): ManifestMcpServer {
  const server: ManifestMcpServer = { name: item.name, status: item.status, reason: item.reason };
  if (item.envRefs !== undefined && item.envRefs.length > 0) server.envRefs = item.envRefs;
  if (item.url !== undefined) {
    server.url = item.url;
    server.transport = item.transport ?? "http";
  }
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
  options: {
    includePreferences: boolean;
    includedHooks: Set<string>;
    includedPlugins: Set<string>;
    diagnostics: Diagnostic[];
  },
): Buffer | null {
  if (!existsSync(settingsPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    options.diagnostics.push({
      severity: "warning",
      message: `${settingsPath} could not be parsed; settings were not exported.`,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as { [key: string]: JsonValue };

  const portable: { [key: string]: JsonValue } = {};
  if (options.includePreferences) {
    for (const key of PORTABLE_SETTINGS_KEYS) {
      if (key in source && !isSensitiveKey(key)) portable[key] = source[key] as JsonValue;
    }
  }
  if (options.includedHooks.has("settings.statusLine") && "statusLine" in source) {
    portable.statusLine = source.statusLine as JsonValue;
  }
  const hooks = source.hooks;
  if (hooks !== null && hooks !== undefined && typeof hooks === "object" && !Array.isArray(hooks)) {
    const confirmed: { [key: string]: JsonValue } = {};
    for (const [event, config] of Object.entries(hooks)) {
      if (options.includedHooks.has(`hooks.${event}`)) confirmed[event] = config;
    }
    if (Object.keys(confirmed).length > 0) portable.hooks = confirmed;
  }

  // Selected plugins travel as their enabledPlugins entries plus only the
  // marketplace sources they reference — names and sources, never code.
  if (options.includedPlugins.size > 0) {
    const enabled = asJsonObject(source.enabledPlugins);
    const marketplaces = asJsonObject(source.extraKnownMarketplaces);
    const carriedPlugins: { [key: string]: JsonValue } = {};
    const carriedMarketplaces: { [key: string]: JsonValue } = {};
    for (const name of [...options.includedPlugins].sort()) {
      if (enabled === null || enabled[name] !== true) continue;
      carriedPlugins[name] = true;
      const marketplaceName = name.split("@")[1];
      if (marketplaceName !== undefined && marketplaces !== null && marketplaceName in marketplaces) {
        carriedMarketplaces[marketplaceName] = marketplaces[marketplaceName] as JsonValue;
      }
    }
    if (Object.keys(carriedPlugins).length > 0) portable.enabledPlugins = carriedPlugins;
    if (Object.keys(carriedMarketplaces).length > 0) portable.extraKnownMarketplaces = carriedMarketplaces;
  }

  if (Object.keys(portable).length === 0) return null;
  const ordered = Object.fromEntries(Object.entries(portable).sort(([a], [b]) => (a < b ? -1 : 1)));
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

function asJsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
