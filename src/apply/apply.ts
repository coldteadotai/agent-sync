import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Manifest } from "../export/collect.js";
import { PORTABLE_SETTINGS_KEYS } from "../scan/scanner.js";
import { CODEX_PORTABLE_SETTINGS_KEYS } from "../scan/codex.js";
import { OPENCODE_PORTABLE_SETTINGS_KEYS } from "../scan/opencode.js";
import { parseToml } from "../scan/toml.js";
import type { LoadedBundle } from "./bundle.js";

const STATE_DIR = ".agent-sync";
const MARKER_VERSION = 1;

export interface Marker {
  version: number;
  appliedAt: string;
  manifest: Manifest;
  created: string[];
  updated: string[];
  // Directories this apply brought into existence (target-relative, sorted).
  // Absent in pre-0.2 markers; undo prunes only what is recorded here, so a
  // directory the user made — even an empty one — is never removed.
  createdDirs?: string[];
  backupDir: string | null;
}

export interface ApplyAction {
  path: string;
  kind: "create" | "update" | "unchanged";
}

export interface ApplyPlan {
  actions: ApplyAction[];
  addedSinceLast: string[];
  previousMarker: Marker | null;
}

export function planApply(bundle: LoadedBundle, targetDir: string): ApplyPlan {
  const actions: ApplyAction[] = [];
  for (const [path, payload] of [...bundle.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Planning runs the same write checks execution will, so a dry run and a
    // real apply always reach the same verdict.
    const destination = resolveForWrite(targetDir, path);
    if (!existsSync(destination)) {
      actions.push({ path, kind: "create" });
      continue;
    }
    if (statSync(destination).isDirectory()) {
      throw new Error(`Refusing to apply: ${path} exists as a directory in the target. Nothing was written.`);
    }
    const current = readFileSync(destination);
    const sameContent = current.equals(payload.content);
    const sameMode =
      process.platform === "win32" ||
      ((statSync(destination).mode & 0o100) !== 0) === payload.executable;
    actions.push({ path, kind: sameContent && sameMode ? "unchanged" : "update" });
  }

  const previousMarker = readMarker(targetDir);
  const previousPaths = new Set(previousMarker?.manifest.files.map((file) => file.path) ?? []);
  const addedSinceLast =
    previousMarker === null
      ? []
      : bundle.manifest.files.map((file) => file.path).filter((path) => !previousPaths.has(path));

  return { actions, addedSinceLast, previousMarker };
}

export function executeApply(bundle: LoadedBundle, targetDir: string, plan: ApplyPlan): Marker | null {
  const created = plan.actions.filter((action) => action.kind === "create").map((action) => action.path);
  const updated = plan.actions.filter((action) => action.kind === "update").map((action) => action.path);
  if (created.length === 0 && updated.length === 0) return null;

  // Every destination is symlink-checked before the first byte moves, so a
  // hostile target layout fails the whole apply rather than half of it.
  for (const path of [...created, ...updated]) resolveForWrite(targetDir, path);

  let backupDir: string | null = null;
  if (updated.length > 0) {
    backupDir = join(STATE_DIR, "backups", `${Date.now()}`);
    for (const path of updated) {
      const source = resolveInside(targetDir, path);
      const backupPath = resolveForWrite(targetDir, `${backupDir}/${path}`);
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(backupPath, readFileSync(source));
      chmodSync(backupPath, statSync(source).mode & 0o777);
    }
  }

  // Directories that will come into existence for this apply, recorded before
  // the first write so undo can prune exactly these and nothing the user made.
  const createdDirs = new Set<string>();
  for (const path of [...created, ...updated]) {
    const parts = path.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const relative = parts.slice(0, depth).join("/");
      if (!existsSync(resolveInside(targetDir, relative))) createdDirs.add(relative);
    }
  }

  // The backup and marker land before the first destructive write, so a failure
  // mid-apply still leaves undo with everything it needs.
  const marker: Marker = {
    version: MARKER_VERSION,
    appliedAt: new Date().toISOString(),
    manifest: bundle.manifest,
    created,
    updated,
    createdDirs: [...createdDirs].sort(),
    backupDir,
  };
  writeMarker(targetDir, marker);

  for (const path of [...created, ...updated]) {
    const payload = bundle.files.get(path);
    if (payload === undefined) continue;
    const destination = resolveForWrite(targetDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, payload.content);
    chmodSync(destination, payload.executable ? 0o755 : 0o644);
  }

  return marker;
}

export interface UndoResult {
  restored: string[];
  removed: string[];
}

export function undoLast(targetDir: string): UndoResult {
  const marker = readMarker(targetDir);
  if (marker === null) throw new Error(`Nothing to undo: no apply marker in ${targetDir}.`);

  const restored: string[] = [];
  const removed: string[] = [];

  for (const path of marker.updated) {
    if (marker.backupDir === null) continue;
    const backupPath = resolveInside(targetDir, `${marker.backupDir}/${path}`);
    if (!existsSync(backupPath)) throw new Error(`Backup for ${path} is missing; undo aborted before touching anything.`);
  }

  for (const path of marker.updated) {
    if (marker.backupDir === null) continue;
    const backupPath = resolveInside(targetDir, `${marker.backupDir}/${path}`);
    const destination = resolveForWrite(targetDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(backupPath));
    chmodSync(destination, statSync(backupPath).mode & 0o777);
    restored.push(path);
  }

  for (const path of marker.created) {
    const destination = resolveForWrite(targetDir, path);
    rmSync(destination, { force: true });
    removed.push(path);
  }

  // Only directories the apply itself brought into existence are pruned, and
  // only if they are empty now — a directory the user made, even an empty
  // one, is never removed. Deepest first, so nested created dirs unwind.
  // Pre-0.2 markers have no createdDirs and get no pruning.
  const createdDirs = marker.createdDirs ?? [];
  const deepestFirst = [...createdDirs].sort(
    (a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1),
  );
  for (const relative of deepestFirst) {
    try {
      rmdirSync(resolveInside(targetDir, relative));
    } catch {
      // Non-empty (something else lives there now) or already gone: leave it.
    }
  }

  rmSync(join(targetDir, STATE_DIR, "last-applied.json"), { force: true });
  return { restored, removed };
}

// The receive-side settings allowlist: exactly the keys buildPortableSettings
// can produce, nothing else. A bundle is untrusted input and the gates below
// are consent filters over KNOWN keys — without this check they fail open on
// unknown ones, and settings.json carries several that execute code on the
// target (apiKeyHelper, env, awsAuthRefresh, ...). An unknown key refuses the
// bundle whole rather than being silently stripped: hostile input should fail
// loudly, matching how a hash mismatch is handled.
const RECEIVABLE_SETTINGS_KEYS = new Set<string>([
  ...PORTABLE_SETTINGS_KEYS,
  "statusLine",
  "hooks",
  "enabledPlugins",
  "extraKnownMarketplaces",
]);

export function assertPortableSettings(bundle: LoadedBundle): void {
  assertNamespacedSettings(bundle);
  const entry = bundle.files.get("settings.json");
  if (entry === undefined) return;
  const settings = readBundleSettings(entry.content);
  for (const key of Object.keys(settings)) {
    if (!RECEIVABLE_SETTINGS_KEYS.has(key)) {
      throw new Error(
        `Refusing bundle: settings.json carries "${key}", which agent-sync never exports. Nothing was written.`,
      );
    }
  }
  for (const key of ["hooks", "enabledPlugins", "extraKnownMarketplaces"] as const) {
    if (key in settings && plainObject(settings[key]) === null) {
      throw new Error(`Refusing bundle: settings.json "${key}" is not an object. Nothing was written.`);
    }
  }
  const enabled = plainObject(settings.enabledPlugins);
  if (enabled !== null) {
    for (const [name, value] of Object.entries(enabled)) {
      if (value !== true) {
        throw new Error(
          `Refusing bundle: enabledPlugins["${name}"] is not true; export never writes disabled entries. Nothing was written.`,
        );
      }
    }
  }
}

// The codex and opencode config files carry portable preference keys only —
// there is no consent-gated content in them, so any other key refuses whole.
function assertNamespacedSettings(bundle: LoadedBundle): void {
  const codex = bundle.files.get("codex/config.toml");
  if (codex !== undefined) {
    let config: Record<string, unknown>;
    try {
      config = parseToml(codex.content.toString("utf8"));
    } catch {
      throw new Error("Refusing bundle: codex/config.toml is not parseable TOML. Nothing was written.");
    }
    const allowed = new Set<string>(CODEX_PORTABLE_SETTINGS_KEYS);
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) {
        throw new Error(`Refusing bundle: codex/config.toml carries "${key}", which agent-sync never exports. Nothing was written.`);
      }
    }
  }
  const opencode = bundle.files.get("opencode/opencode.json");
  if (opencode !== undefined) {
    const config = readBundleSettings(opencode.content, "opencode/opencode.json");
    const allowed = new Set<string>(OPENCODE_PORTABLE_SETTINGS_KEYS);
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) {
        throw new Error(`Refusing bundle: opencode/opencode.json carries "${key}", which agent-sync never exports. Nothing was written.`);
      }
    }
  }
}

function readBundleSettings(content: Buffer, label = "settings.json"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`Refusing bundle: ${label} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Refusing bundle: ${label} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Settled decision 5, receive side: hooks and statusLine are arbitrary shell
// commands, so the machine that runs them re-confirms each one. Anything not
// named in confirmedHooks is stripped from the bundle's settings.json.
export function gateSettingsHooks(bundle: LoadedBundle, confirmedHooks: string[]): string[] {
  const entry = bundle.files.get("settings.json");
  if (entry === undefined) {
    if (confirmedHooks.length > 0) throw new Error("--hook given but the bundle carries no settings.json.");
    return [];
  }
  const settings = readBundleSettings(entry.content);

  const present = new Set<string>();
  if ("statusLine" in settings) present.add("settings.statusLine");
  const hooks = settings.hooks;
  if (hooks !== undefined && plainObject(hooks) === null) {
    throw new Error('Refusing bundle: settings.json "hooks" is not an object. Nothing was written.');
  }
  const hookEvents = hooks === undefined ? [] : Object.keys(hooks as Record<string, unknown>);
  for (const event of hookEvents) present.add(`hooks.${event}`);

  for (const requested of confirmedHooks) {
    if (!present.has(requested)) throw new Error(`--hook ${requested} does not match anything in this bundle.`);
  }

  const confirmed = new Set(confirmedHooks);
  const withheld: string[] = [];
  if (present.has("settings.statusLine") && !confirmed.has("settings.statusLine")) {
    delete settings.statusLine;
    withheld.push("settings.statusLine");
  }
  if (hookEvents.length > 0) {
    const kept: Record<string, unknown> = {};
    for (const event of hookEvents.sort()) {
      if (confirmed.has(`hooks.${event}`)) kept[event] = (hooks as Record<string, unknown>)[event];
      else withheld.push(`hooks.${event}`);
    }
    if (Object.keys(kept).length > 0) settings.hooks = kept;
    else delete settings.hooks;
  }

  if (withheld.length === 0) return [];
  if (Object.keys(settings).length === 0) {
    bundle.files.delete("settings.json");
    bundle.manifest.files = bundle.manifest.files.filter((file) => file.path !== "settings.json");
  } else {
    const ordered = Object.fromEntries(Object.entries(settings).sort(([a], [b]) => (a < b ? -1 : 1)));
    const content = Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, "utf8");
    bundle.files.set("settings.json", { content, executable: false });
    // The marker records this manifest as what was applied, so the entry must
    // describe the post-gate bytes, not the source bundle's.
    for (const file of bundle.manifest.files) {
      if (file.path === "settings.json") {
        file.sha256 = createHash("sha256").update(content).digest("hex");
        file.size = content.length;
      }
    }
  }
  return withheld;
}

// Enabling a plugin makes the target install and run marketplace code, so the
// receiving machine re-confirms each one, exactly as it does for hooks.
// Anything not named in confirmedPlugins is stripped from the bundle's
// settings.json. Marketplace pruning is unconditional: a marketplace survives
// only when a CONFIRMED plugin references it, so neither a bundle with
// marketplaces and no plugins nor an unreferenced marketplace riding beside
// fully-confirmed plugins can smuggle one through.
export function gateSettingsPlugins(bundle: LoadedBundle, confirmedPlugins: string[]): string[] {
  const entry = bundle.files.get("settings.json");
  if (entry === undefined) {
    if (confirmedPlugins.length > 0) throw new Error("--plugin given but the bundle carries no settings.json.");
    return [];
  }
  const settings = readBundleSettings(entry.content);

  const enabledRaw = settings.enabledPlugins;
  if (enabledRaw !== undefined && plainObject(enabledRaw) === null) {
    throw new Error('Refusing bundle: settings.json "enabledPlugins" is not an object. Nothing was written.');
  }
  const marketplacesRaw = settings.extraKnownMarketplaces;
  if (marketplacesRaw !== undefined && plainObject(marketplacesRaw) === null) {
    throw new Error('Refusing bundle: settings.json "extraKnownMarketplaces" is not an object. Nothing was written.');
  }
  if (enabledRaw === undefined && marketplacesRaw === undefined) {
    if (confirmedPlugins.length > 0) {
      throw new Error(`--plugin ${confirmedPlugins[0]} does not match anything in this bundle.`);
    }
    return [];
  }

  const enabled = plainObject(enabledRaw) ?? {};
  const pluginNames = Object.keys(enabled);
  for (const requested of confirmedPlugins) {
    if (!pluginNames.includes(requested)) {
      throw new Error(`--plugin ${requested} does not match anything in this bundle.`);
    }
  }

  const confirmed = new Set(confirmedPlugins);
  const withheld: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const name of pluginNames.sort()) {
    if (confirmed.has(name)) kept[name] = enabled[name];
    else withheld.push(name);
  }

  if (Object.keys(kept).length > 0) settings.enabledPlugins = kept;
  else delete settings.enabledPlugins;

  const marketplaces = plainObject(marketplacesRaw);
  if (marketplaces !== null) {
    const referenced = new Set(
      Object.keys(kept)
        .map((name) => name.split("@")[1])
        .filter((name): name is string => name !== undefined),
    );
    const keptMarketplaces: Record<string, unknown> = {};
    for (const [name, source] of Object.entries(marketplaces)) {
      if (referenced.has(name)) keptMarketplaces[name] = source;
    }
    if (Object.keys(keptMarketplaces).length > 0) settings.extraKnownMarketplaces = keptMarketplaces;
    else delete settings.extraKnownMarketplaces;
  }

  if (Object.keys(settings).length === 0) {
    bundle.files.delete("settings.json");
    bundle.manifest.files = bundle.manifest.files.filter((file) => file.path !== "settings.json");
  } else {
    const ordered = Object.fromEntries(Object.entries(settings).sort(([a], [b]) => (a < b ? -1 : 1)));
    const content = Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, "utf8");
    bundle.files.set("settings.json", { content, executable: false });
    for (const file of bundle.manifest.files) {
      if (file.path === "settings.json") {
        file.sha256 = createHash("sha256").update(content).digest("hex");
        file.size = content.length;
      }
    }
  }
  return withheld;
}

export function readMarker(targetDir: string): Marker | null {
  const markerPath = join(targetDir, STATE_DIR, "last-applied.json");
  if (!existsSync(markerPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const marker = parsed as Marker;
    if (marker.version !== MARKER_VERSION) return null;
    return marker;
  } catch {
    return null;
  }
}

function writeMarker(targetDir: string, marker: Marker): void {
  const markerPath = resolveForWrite(targetDir, `${STATE_DIR}/last-applied.json`);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

// The per-agent target roots the tool owns. Codex splits across two real
// roots (its home and the shared ~/.agents skills dir); OpenCode lives under
// XDG config. The claude root keeps honoring --target and CLAUDE_CONFIG_DIR.
export interface AgentRoots {
  claude: string;
  codexHome: string;
  codexAgents: string;
  opencodeConfig: string;
}

export function defaultAgentRoots(
  claudeTarget?: string,
  env: Record<string, string | undefined> = process.env,
): AgentRoots {
  return {
    claude: claudeTarget ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
    codexAgents: join(homedir(), ".agents"),
    opencodeConfig: join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode"),
  };
}

export interface RootSlice {
  root: string;
  agent: "claude-code" | "codex" | "opencode";
  bundle: LoadedBundle;
}

// Splits a bundle into per-root sub-bundles with rebased paths, so the
// existing plan/execute/undo machinery — markers, backups, write policy and
// symlink containment included — runs unchanged per root.
export function splitBundleByRoot(bundle: LoadedBundle, roots: AgentRoots): RootSlice[] {
  // Keyed by the RESOLVED root path: two logical roots pointing at the same
  // directory (CODEX_HOME aimed at the claude target, spelling variants)
  // merge into one slice, so that directory gets one apply and one marker
  // instead of the second marker orphaning the first slice's files.
  const slices = new Map<string, RootSlice>();
  const place = (root: string, agent: RootSlice["agent"], rebased: string, path: string): void => {
    const key = resolve(root);
    let slice = slices.get(key);
    if (slice === undefined) {
      slice = {
        root,
        agent,
        // Non-claude slices carry only their own files: a codex marker
        // claiming claude's hooks or plugins would mislead anyone reading it.
        bundle: {
          manifest:
            agent === "claude-code"
              ? { ...bundle.manifest, files: [] }
              : {
                  schemaVersion: bundle.manifest.schemaVersion,
                  tool: bundle.manifest.tool,
                  agent: bundle.manifest.agent,
                  files: [],
                  mcpServers: [],
                  hooks: [],
                },
          files: new Map(),
        },
      };
      slices.set(key, slice);
    }
    const payload = bundle.files.get(path);
    if (payload === undefined) return;
    slice.bundle.files.set(rebased, payload);
    const manifestFile = bundle.manifest.files.find((file) => file.path === path);
    if (manifestFile !== undefined) slice.bundle.manifest.files.push({ ...manifestFile, path: rebased });
  };

  for (const path of [...bundle.files.keys()].sort()) {
    if (path.startsWith("codex/skills/")) place(roots.codexAgents, "codex", path.slice("codex/".length), path);
    else if (path.startsWith("codex/")) place(roots.codexHome, "codex", path.slice("codex/".length), path);
    else if (path.startsWith("opencode/")) place(roots.opencodeConfig, "opencode", path.slice("opencode/".length), path);
    else place(roots.claude, "claude-code", path, path);
  }

  const order: RootSlice["agent"][] = ["claude-code", "codex", "opencode"];
  return [...slices.values()].sort(
    (a, b) => order.indexOf(a.agent) - order.indexOf(b.agent) || (a.root < b.root ? -1 : 1),
  );
}

// Defense in depth behind the manifest path validation: the joined destination
// must stay inside the target directory.
export function resolveInside(targetDir: string, path: string): string {
  const base = resolve(targetDir);
  const destination = resolve(base, ...path.split("/"));
  if (destination !== base && !destination.startsWith(base + sep)) {
    throw new Error(`Refusing to write outside the target directory: ${path}`);
  }
  return destination;
}

// Lexical containment is not enough for writes: a pre-existing symlink at any
// component inside the target would carry the write outside it. The target
// directory itself may legitimately be a symlink; anything under it may not be.
export function resolveForWrite(targetDir: string, path: string): string {
  const destination = resolveInside(targetDir, path);
  let current = resolve(targetDir);
  for (const component of path.split("/")) {
    current = join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlink inside the target: ${current}`);
    }
  }
  return destination;
}
