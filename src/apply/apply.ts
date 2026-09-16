import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Manifest } from "../export/collect.js";
import type { LoadedBundle } from "./bundle.js";

const STATE_DIR = ".agent-sync";
const MARKER_VERSION = 1;

export interface Marker {
  version: number;
  appliedAt: string;
  manifest: Manifest;
  created: string[];
  updated: string[];
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

  // The backup and marker land before the first destructive write, so a failure
  // mid-apply still leaves undo with everything it needs.
  const marker: Marker = {
    version: MARKER_VERSION,
    appliedAt: new Date().toISOString(),
    manifest: bundle.manifest,
    created,
    updated,
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

  rmSync(join(targetDir, STATE_DIR, "last-applied.json"), { force: true });
  return { restored, removed };
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content.toString("utf8"));
  } catch {
    throw new Error("Refusing bundle: settings.json is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Refusing bundle: settings.json is not an object.");
  }
  const settings = parsed as Record<string, unknown>;

  const present = new Set<string>();
  if ("statusLine" in settings) present.add("settings.statusLine");
  const hooks = settings.hooks;
  const hookEvents =
    hooks !== null && hooks !== undefined && typeof hooks === "object" && !Array.isArray(hooks)
      ? Object.keys(hooks as Record<string, unknown>)
      : [];
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
// settings.json, along with marketplaces no surviving plugin references.
export function gateSettingsPlugins(bundle: LoadedBundle, confirmedPlugins: string[]): string[] {
  const entry = bundle.files.get("settings.json");
  if (entry === undefined) {
    if (confirmedPlugins.length > 0) throw new Error("--plugin given but the bundle carries no settings.json.");
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content.toString("utf8"));
  } catch {
    throw new Error("Refusing bundle: settings.json is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Refusing bundle: settings.json is not an object.");
  }
  const settings = parsed as Record<string, unknown>;

  const enabled = settings.enabledPlugins;
  const pluginNames =
    enabled !== null && enabled !== undefined && typeof enabled === "object" && !Array.isArray(enabled)
      ? Object.keys(enabled as Record<string, unknown>)
      : [];
  for (const requested of confirmedPlugins) {
    if (!pluginNames.includes(requested)) {
      throw new Error(`--plugin ${requested} does not match anything in this bundle.`);
    }
  }
  if (pluginNames.length === 0) return [];

  const confirmed = new Set(confirmedPlugins);
  const withheld: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const name of pluginNames.sort()) {
    if (confirmed.has(name)) kept[name] = (enabled as Record<string, unknown>)[name];
    else withheld.push(name);
  }
  if (withheld.length === 0) return [];

  if (Object.keys(kept).length > 0) settings.enabledPlugins = kept;
  else delete settings.enabledPlugins;

  const marketplaces = settings.extraKnownMarketplaces;
  if (marketplaces !== null && marketplaces !== undefined && typeof marketplaces === "object" && !Array.isArray(marketplaces)) {
    const referenced = new Set(
      Object.keys(kept)
        .map((name) => name.split("@")[1])
        .filter((name): name is string => name !== undefined),
    );
    const keptMarketplaces: Record<string, unknown> = {};
    for (const [name, source] of Object.entries(marketplaces as Record<string, unknown>)) {
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
