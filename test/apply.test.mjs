import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTar,
  loadBundleFromBuffer,
  loadBundleFromDirectory,
  planApply,
} from "../dist/main.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO_ROOT, "bin", "agent-sync.mjs");

let root;
let sourceDir;
let bundleTar;

function runCli(args, env = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: sourceDir, ...env },
  });
}

function freshTarget(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-apply-"));
  sourceDir = join(root, "source-claude");
  const skill = join(sourceDir, "skills", "reviewer");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# reviewer\n");
  writeFileSync(join(skill, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  writeFileSync(join(sourceDir, "CLAUDE.md"), "memory v1\n");
  writeFileSync(
    join(sourceDir, "settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "prettier --write" }] }] },
    }),
  );
  writeFileSync(join(sourceDir, ".claude.json"), "{}");

  bundleTar = join(root, "bundle.tar");
  runCli(["export", bundleTar]);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("roundtrip: apply reproduces the exported tree, including the exec bit", () => {
  const target = freshTarget("roundtrip");
  const output = runCli(["apply", bundleTar, "--target", target]);
  assert.match(output, /Done: 4 created, 0 updated\./);
  assert.equal(readFileSync(join(target, "CLAUDE.md"), "utf8"), "memory v1\n");
  assert.equal(readFileSync(join(target, "skills", "reviewer", "SKILL.md"), "utf8"), "# reviewer\n");
  assert.equal(statSync(join(target, "skills", "reviewer", "run.sh")).mode & 0o777, 0o755);
});

test("re-apply is idempotent and says so", () => {
  const target = freshTarget("idempotent");
  runCli(["apply", bundleTar, "--target", target]);
  const second = runCli(["apply", bundleTar, "--target", target]);
  assert.match(second, /Nothing to change/);
  assert.ok(!existsSync(join(target, ".agent-sync", "backups")), "no backup for a no-op apply");
});

test("gzip bundles and stdin pipes both apply", () => {
  const tgz = join(root, "bundle.tgz");
  runCli(["export", tgz]);
  const gzTarget = freshTarget("from-tgz");
  runCli(["apply", tgz, "--target", gzTarget]);
  assert.equal(readFileSync(join(gzTarget, "CLAUDE.md"), "utf8"), "memory v1\n");

  const pipeTarget = freshTarget("from-pipe");
  execSync(
    `"${process.execPath}" "${BIN}" export - 2>/dev/null | "${process.execPath}" "${BIN}" apply - --target "${pipeTarget}"`,
    { cwd: REPO_ROOT, env: { ...process.env, CLAUDE_CONFIG_DIR: sourceDir } },
  );
  assert.equal(readFileSync(join(pipeTarget, "CLAUDE.md"), "utf8"), "memory v1\n");
});

test("apply backs up what it overwrites and undo restores it", () => {
  const target = freshTarget("undoable");
  writeFileSync(join(target, "CLAUDE.md"), "precious local memory\n");
  const output = runCli(["apply", bundleTar, "--target", target]);
  assert.match(output, /Backed up 1 overwritten file/);
  assert.equal(readFileSync(join(target, "CLAUDE.md"), "utf8"), "memory v1\n");

  const undone = runCli(["undo", "--target", target]);
  assert.match(undone, /Restored 1 file\(s\), removed 3 created file\(s\)\./);
  assert.equal(readFileSync(join(target, "CLAUDE.md"), "utf8"), "precious local memory\n");
  assert.ok(!existsSync(join(target, "skills", "reviewer", "SKILL.md")));

  assert.throws(() => runCli(["undo", "--target", target]), /status.*2|Nothing to undo/s);
});

test("re-apply names what is new since the last apply", () => {
  const target = freshTarget("diff-naming");
  runCli(["apply", bundleTar, "--target", target]);

  const extraSkill = join(sourceDir, "skills", "extra");
  mkdirSync(extraSkill, { recursive: true });
  writeFileSync(join(extraSkill, "SKILL.md"), "# extra\n");
  const v2 = join(root, "bundle-v2.tar");
  runCli(["export", v2]);
  try {
    const output = runCli(["apply", v2, "--target", target]);
    assert.match(output, /1 new since last apply: skills\/extra\/SKILL\.md/);
  } finally {
    rmSync(extraSkill, { recursive: true, force: true });
  }
});

test("dry-run prints the plan and writes nothing", () => {
  const target = freshTarget("dry");
  const output = runCli(["apply", bundleTar, "--target", target, "--dry-run"]);
  assert.match(output, /Would apply/);
  assert.ok(!existsSync(join(target, "CLAUDE.md")));
  assert.ok(!existsSync(join(target, ".agent-sync")));
});

test("traversal, absolute and backslash paths are rejected", () => {
  for (const evil of ["../evil.md", "a/../../evil.md", "/etc/evil", "a\\b.md"]) {
    const tar = createTar([
      { path: "manifest.json", content: Buffer.from("{}") },
      { path: evil, content: Buffer.from("x") },
    ]);
    assert.throws(() => loadBundleFromBuffer(tar), /Refusing archive/, evil);
  }
});

test("symlink and hardlink tar entries are rejected", () => {
  for (const typeflag of ["2", "1", "L", "x"]) {
    const tar = createTar([{ path: "files/CLAUDE.md", content: Buffer.from("x") }]);
    setTypeflag(tar, 0, typeflag);
    assert.throws(() => loadBundleFromBuffer(tar), /unsupported type/, `typeflag ${typeflag}`);
  }
});

test("duplicate entries are rejected", () => {
  const tar = createTar([
    { path: "files/a.md", content: Buffer.from("one") },
    { path: "files/b.md", content: Buffer.from("two") },
  ]);
  const twice = Buffer.concat([tar.subarray(0, tar.length - 1024), tar]);
  assert.throws(() => loadBundleFromBuffer(twice), /duplicate entry/);
});

test("a tampered payload is refused before anything is written", () => {
  const dir = join(root, "tampered-bundle");
  runCli(["export", dir]);
  const victim = join(dir, "files", "CLAUDE.md");
  writeFileSync(victim, "memory v1?\n");
  const target = freshTarget("tamper-target");
  assert.throws(() => runCli(["apply", dir, "--target", target]), /does not match its manifest hash/);
  assert.ok(!existsSync(join(target, "CLAUDE.md")), "tampered apply must write nothing");
  assert.ok(!existsSync(join(target, ".agent-sync")));
});

test("payload files missing from the manifest are refused", () => {
  const dir = join(root, "rogue-bundle");
  runCli(["export", dir]);
  writeFileSync(join(dir, "files", "rogue.md"), "surprise\n");
  assert.throws(() => loadBundleFromDirectory(dir), /not in the manifest/);
});

test("credential-shaped and state-dir paths in a manifest are refused", () => {
  for (const path of [
    "skills/x/id_rsa",
    "skills/x/server.key",
    ".agent-sync/last-applied.json",
    ".AGENT-SYNC/last-applied.json",
    ".CREDENTIALS.JSON",
    ".ENV",
    "skills/x/ID_RSA",
    ".claude.json",
    "skills/x/.CLAUDE.JSON",
    "projects/session.jsonl",
    "PROJECTS/session.jsonl",
    "history.jsonl",
  ]) {
    const content = Buffer.from("evil");
    const manifest = {
      schemaVersion: 1,
      tool: "agent-sync",
      agent: "claude-code",
      files: [{ path, sha256: sha256Hex(content), size: content.length }],
      mcpServers: [],
      hooks: [],
    };
    const tar = createTar([
      { path: "manifest.json", content: Buffer.from(JSON.stringify(manifest)) },
      { path: `files/${path}`, content },
    ]);
    assert.throws(() => loadBundleFromBuffer(tar), /Refusing bundle/, path);
  }
});

test("a manifest with ancestor-descendant paths is refused whole", () => {
  const a = Buffer.from("file at a");
  const b = Buffer.from("file at a/b");
  const manifest = {
    schemaVersion: 1,
    tool: "agent-sync",
    agent: "claude-code",
    files: [
      { path: "a", sha256: sha256Hex(a), size: a.length },
      { path: "a/b", sha256: sha256Hex(b), size: b.length },
    ],
    mcpServers: [],
    hooks: [],
  };
  const tar = createTar([
    { path: "manifest.json", content: Buffer.from(JSON.stringify(manifest)) },
    { path: "files/a", content: a },
    { path: "files/a/b", content: b },
  ]);
  assert.throws(() => loadBundleFromBuffer(tar), /both a file and a parent/);
});

test("duplicate manifest paths are refused", () => {
  const a = Buffer.from("payload");
  const entry = { path: "a.md", sha256: sha256Hex(a), size: a.length };
  const manifest = { schemaVersion: 1, tool: "agent-sync", agent: "claude-code", files: [entry, { ...entry }], mcpServers: [], hooks: [] };
  const tar = createTar([
    { path: "manifest.json", content: Buffer.from(JSON.stringify(manifest)) },
    { path: "files/a.md", content: a },
  ]);
  assert.throws(() => loadBundleFromBuffer(tar), /duplicate manifest path/);
});

test("dry-run reaches the same verdict as a real apply on a hostile layout", () => {
  const outside = freshTarget("dry-outside");
  const target = freshTarget("dry-symlinked");
  symlinkSync(outside, join(target, "skills"));
  assert.throws(() => runCli(["apply", bundleTar, "--target", target, "--dry-run"]), /symlink inside the target/);
  assert.deepEqual(readdirSync(outside), []);
});

test("a directory sitting where a file must go is a clean whole refusal", () => {
  const target = freshTarget("dir-in-the-way");
  mkdirSync(join(target, "CLAUDE.md"));
  assert.throws(() => runCli(["apply", bundleTar, "--target", target]), /exists as a directory/);
  assert.ok(!existsSync(join(target, ".agent-sync")), "refusal happened before any write");
});

test("the marker records the post-gate settings hash, matching disk", () => {
  const hooked = join(root, "marker-hash.tar");
  runCli(["export", hooked, "--hook", "hooks.PostToolUse"]);
  const target = freshTarget("marker-hash");
  runCli(["apply", hooked, "--target", target]);
  const marker = JSON.parse(readFileSync(join(target, ".agent-sync", "last-applied.json"), "utf8"));
  const entry = marker.manifest.files.find((file) => file.path === "settings.json");
  const disk = readFileSync(join(target, "settings.json"));
  assert.equal(entry.sha256, sha256Hex(disk));
  assert.equal(entry.size, disk.length);
});

test("a newer manifest schema asks for a newer tool instead of guessing", () => {
  const manifest = { schemaVersion: 2, files: [] };
  const tar = createTar([{ path: "manifest.json", content: Buffer.from(JSON.stringify(manifest)) }]);
  assert.throws(() => loadBundleFromBuffer(tar), /needs a newer agent-sync/);
});

test("undo aborts untouched when a backup file is missing", () => {
  const target = freshTarget("broken-backup");
  writeFileSync(join(target, "CLAUDE.md"), "precious\n");
  runCli(["apply", bundleTar, "--target", target]);
  const marker = JSON.parse(readFileSync(join(target, ".agent-sync", "last-applied.json"), "utf8"));
  rmSync(join(target, marker.backupDir), { recursive: true, force: true });
  assert.throws(() => runCli(["undo", "--target", target]), /undo aborted/);
  assert.equal(readFileSync(join(target, "CLAUDE.md"), "utf8"), "memory v1\n", "target untouched by aborted undo");
});

test("a symlink directory inside the target cannot carry writes outside", () => {
  const outside = freshTarget("outside-dir");
  const target = freshTarget("symlinked-target");
  symlinkSync(outside, join(target, "skills"));
  assert.throws(() => runCli(["apply", bundleTar, "--target", target]), /through a symlink inside the target/);
  assert.deepEqual(readdirSync(outside), [], "nothing may land outside the target");
});

test("a symlink at the destination file itself is refused", () => {
  const target = freshTarget("symlinked-file");
  const outsideFile = join(root, "outside-file.md");
  writeFileSync(outsideFile, "outside\n");
  symlinkSync(outsideFile, join(target, "CLAUDE.md"));
  assert.throws(() => runCli(["apply", bundleTar, "--target", target]), /symlink inside the target/);
  assert.equal(readFileSync(outsideFile, "utf8"), "outside\n", "linked file untouched");
});

test("a target that is itself a symlink is allowed", () => {
  const real = freshTarget("real-target");
  const link = join(root, "link-target");
  symlinkSync(real, link);
  runCli(["apply", bundleTar, "--target", link]);
  assert.equal(readFileSync(join(real, "CLAUDE.md"), "utf8"), "memory v1\n");
});

test("hooks in a bundle are withheld unless re-confirmed at apply", () => {
  const hooked = join(root, "hooked.tar");
  runCli(["export", hooked, "--hook", "hooks.PostToolUse"]);

  const gated = freshTarget("hooks-gated");
  const output = runCli(["apply", hooked, "--target", gated]);
  assert.match(output, /Withheld hooks\.PostToolUse/);
  const withheldSettings = JSON.parse(readFileSync(join(gated, "settings.json"), "utf8"));
  assert.equal(withheldSettings.hooks, undefined);
  assert.equal(withheldSettings.model, "opus");

  const confirmed = freshTarget("hooks-confirmed");
  runCli(["apply", hooked, "--target", confirmed, "--hook", "hooks.PostToolUse"]);
  const confirmedSettings = JSON.parse(readFileSync(join(confirmed, "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(confirmedSettings.hooks), ["PostToolUse"]);
});

test("an apply --hook that names nothing in the bundle is an error", () => {
  const target = freshTarget("bad-hook-name");
  assert.throws(
    () => runCli(["apply", bundleTar, "--target", target, "--hook", "hooks.DoesNotExist"]),
    /does not match anything in this bundle/,
  );
  assert.ok(!existsSync(join(target, "CLAUDE.md")));
});

test("mode-only drift counts as an update and gets corrected", () => {
  const target = freshTarget("mode-drift");
  runCli(["apply", bundleTar, "--target", target]);
  const script = join(target, "skills", "reviewer", "run.sh");
  chmodSync(script, 0o644);
  const bundle = loadBundleFromBuffer(readFileSync(bundleTar));
  const plan = planApply(bundle, target);
  assert.equal(plan.actions.find((action) => action.path === "skills/reviewer/run.sh").kind, "update");
  runCli(["apply", bundleTar, "--target", target]);
  assert.equal(statSync(script).mode & 0o777, 0o755);
});

function setTypeflag(tar, headerOffset, typeflag) {
  tar.write(typeflag, headerOffset + 156, 1, "latin1");
  tar.fill(0x20, headerOffset + 148, headerOffset + 156);
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += tar[headerOffset + index];
  tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, headerOffset + 148, 8, "latin1");
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
