import {
  chmodSync,
  existsSync,
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
    const destination = resolveInside(targetDir, path);
    if (!existsSync(destination)) {
      actions.push({ path, kind: "create" });
      continue;
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

  let backupDir: string | null = null;
  if (updated.length > 0) {
    backupDir = join(STATE_DIR, "backups", `${Date.now()}`);
    for (const path of updated) {
      const source = resolveInside(targetDir, path);
      const backupPath = resolveInside(targetDir, `${backupDir}/${path}`);
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
    const destination = resolveInside(targetDir, path);
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
    const destination = resolveInside(targetDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(backupPath));
    chmodSync(destination, statSync(backupPath).mode & 0o777);
    restored.push(path);
  }

  for (const path of marker.created) {
    const destination = resolveInside(targetDir, path);
    rmSync(destination, { force: true });
    removed.push(path);
  }

  rmSync(join(targetDir, STATE_DIR, "last-applied.json"), { force: true });
  return { restored, removed };
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
  const markerPath = join(targetDir, STATE_DIR, "last-applied.json");
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
