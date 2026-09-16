import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIAL_FILE_PATTERNS,
  MANIFEST_SCHEMA_VERSION,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type Manifest,
  type ManifestFile,
} from "../export/collect.js";
import { parseTar, validateArchivePath } from "./untar.js";

export interface LoadedBundle {
  manifest: Manifest;
  files: Map<string, { content: Buffer; executable: boolean }>;
}

export function loadBundleFromBuffer(buffer: Buffer): LoadedBundle {
  const payloads = new Map<string, Buffer>();
  let manifestBytes: Buffer | null = null;

  for (const entry of parseTar(buffer)) {
    if (entry.type === "directory") continue;
    if (entry.path === "manifest.json") {
      manifestBytes = entry.content;
      continue;
    }
    if (!entry.path.startsWith("files/")) {
      throw new Error(`Refusing bundle: unexpected entry ${entry.path} outside files/.`);
    }
    payloads.set(entry.path.slice("files/".length), entry.content);
  }

  return assemble(manifestBytes, payloads);
}

export function loadBundleFromDirectory(root: string): LoadedBundle {
  const manifestPath = join(root, "manifest.json");
  const manifestStat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (manifestStat === undefined || !manifestStat.isFile()) {
    throw new Error(`No manifest.json in ${root}; not an agent-sync bundle.`);
  }
  const payloads = new Map<string, Buffer>();
  collectPayloads(join(root, "files"), "", payloads);
  return assemble(readFileSync(manifestPath), payloads);
}

function collectPayloads(directory: string, relative: string, payloads: Map<string, Buffer>): void {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (!stat.isDirectory()) throw new Error(`Refusing bundle: ${directory} is not a directory.`);
  for (const name of readdirSync(directory)) {
    const sourcePath = join(directory, name);
    const bundlePath = relative.length === 0 ? name : `${relative}/${name}`;
    const entryStat = lstatSync(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Refusing bundle: ${bundlePath} is a symlink.`);
    }
    if (entryStat.isDirectory()) {
      collectPayloads(sourcePath, bundlePath, payloads);
    } else if (entryStat.isFile()) {
      payloads.set(bundlePath, readFileSync(sourcePath));
    } else {
      throw new Error(`Refusing bundle: ${bundlePath} is not a regular file.`);
    }
  }
}

function assemble(manifestBytes: Buffer | null, payloads: Map<string, Buffer>): LoadedBundle {
  if (manifestBytes === null) throw new Error("Refusing bundle: no manifest.json.");
  if (manifestBytes.length > MAX_FILE_BYTES) throw new Error("Refusing bundle: manifest.json exceeds the size limit.");

  const manifest = parseManifest(manifestBytes);
  const files = new Map<string, { content: Buffer; executable: boolean }>();
  let totalBytes = 0;

  for (const file of manifest.files) {
    const content = payloads.get(file.path);
    if (content === undefined) {
      throw new Error(`Refusing bundle: manifest lists ${file.path} but the payload is missing.`);
    }
    if (content.length > MAX_FILE_BYTES) {
      throw new Error(`Refusing bundle: ${file.path} exceeds the per-file size limit.`);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Refusing bundle: total size exceeds the bundle limit.");
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== file.sha256 || content.length !== file.size) {
      throw new Error(`Refusing bundle: ${file.path} does not match its manifest hash. Nothing was written.`);
    }
    files.set(file.path, { content, executable: file.executable === true });
  }

  for (const path of payloads.keys()) {
    if (!files.has(path)) {
      throw new Error(`Refusing bundle: ${path} is in the payload but not in the manifest. Nothing was written.`);
    }
  }

  return { manifest, files };
}

function parseManifest(bytes: Buffer): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Refusing bundle: manifest.json is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Refusing bundle: manifest.json is not an object.");
  }
  const manifest = parsed as Partial<Manifest> & { schemaVersion?: unknown };
  if (typeof manifest.schemaVersion !== "number" || manifest.schemaVersion > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `This bundle needs a newer agent-sync (manifest schema ${String(manifest.schemaVersion)}; this tool understands up to ${MANIFEST_SCHEMA_VERSION}).`,
    );
  }
  if (!Array.isArray(manifest.files)) throw new Error("Refusing bundle: manifest has no files list.");

  const seenPaths = new Set<string>();
  for (const file of manifest.files as unknown[]) {
    if (file === null || typeof file !== "object") throw new Error("Refusing bundle: malformed file entry.");
    const record = file as ManifestFile;
    if (typeof record.path !== "string" || typeof record.sha256 !== "string" || typeof record.size !== "number") {
      throw new Error("Refusing bundle: malformed file entry.");
    }
    if (!/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw new Error(`Refusing bundle: ${record.path} has a malformed hash.`);
    }
    validateArchivePath(record.path, false);
    assertWritablePath(record.path);
    if (seenPaths.has(record.path)) throw new Error(`Refusing bundle: duplicate manifest path ${record.path}.`);
    seenPaths.add(record.path);
  }

  // A path that is an ancestor of another would half-apply: the ancestor lands
  // as a file, then its descendant fails with the target already modified.
  for (const path of seenPaths) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join("/");
      if (seenPaths.has(ancestor)) {
        throw new Error(`Refusing bundle: ${ancestor} is both a file and a parent of ${path}. Nothing was written.`);
      }
    }
  }

  return {
    schemaVersion: manifest.schemaVersion,
    tool: "agent-sync",
    agent: "claude-code",
    files: manifest.files as ManifestFile[],
    mcpServers: Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [],
    hooks: Array.isArray(manifest.hooks) ? manifest.hooks : [],
  };
}

// The target-path policy is an allowlist of exactly what export can produce.
// A bundle is attacker-controlled input, and a denylist over an open path
// space loses to whatever it forgot to name (settings.local.json carrying
// unconsented hooks, agent-sync's own marker, a future config file): anything
// not on this list is refused whole. Credential-shaped names are still
// refused at any depth, case-folded because targets may sit on
// case-insensitive filesystems.
const WRITABLE_ROOT_FILES = ["CLAUDE.md", "settings.json"];
const WRITABLE_ROOT_DIRS = ["skills", "agents", "commands"];

export function assertWritablePath(path: string): void {
  const components = path.split("/");
  const root = components[0] ?? "";
  const allowed =
    (components.length === 1 && WRITABLE_ROOT_FILES.includes(root)) ||
    (components.length > 1 && WRITABLE_ROOT_DIRS.includes(root));
  if (!allowed) {
    throw new Error(
      `Refusing bundle: ${path} is not a path agent-sync exports (CLAUDE.md, settings.json, skills/, agents/, commands/). Nothing was written.`,
    );
  }
  for (const component of components) {
    if (/^\.claude\.json$/i.test(component)) {
      throw new Error(`Refusing bundle: ${path} targets the credential-bearing .claude.json. Nothing was written.`);
    }
    if (CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(component))) {
      throw new Error(`Refusing bundle: ${path} matches a credential filename pattern. Nothing was written.`);
    }
  }
}
