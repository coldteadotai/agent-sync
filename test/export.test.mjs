import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectExport } from "../dist/main.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PLANTED = {
  envFile: "planted-dotenv-secret",
  pemFile: "planted-pem-secret",
  sshKey: "planted-sshkey-secret",
  fidoKey: "planted-fido-key-secret",
  bakKey: "planted-backup-key-secret",
  tlsKey: "planted-tls-key-secret",
  helper: "sk-planted-helper-secret",
  hookSecret: "planted-unconfirmed-hook",
};

const LONG_NAME = `long-${"x".repeat(110)}.md`;

let root;
let userDir;

function runCli(args) {
  return execFileSync(process.execPath, ["bin/agent-sync.mjs", ...args], {
    cwd: REPO_ROOT,
    encoding: "buffer",
    env: { ...process.env, CLAUDE_CONFIG_DIR: userDir },
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-export-"));
  userDir = join(root, ".claude");

  const skill = join(userDir, "skills", "reviewer");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# reviewer\n");
  writeFileSync(join(skill, "references", "guide.md"), "guide\n");
  writeFileSync(join(skill, ".env"), PLANTED.envFile);
  writeFileSync(join(skill, "cert.pem"), PLANTED.pemFile);
  writeFileSync(join(skill, "id_rsa"), PLANTED.sshKey);
  writeFileSync(join(skill, "id_ed25519_sk"), PLANTED.fidoKey);
  writeFileSync(join(skill, "id_rsa.bak"), PLANTED.bakKey);
  writeFileSync(join(skill, "server.key"), PLANTED.tlsKey);
  writeFileSync(join(skill, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  writeFileSync(join(skill, LONG_NAME), "name too long for ustar\n");
  symlinkSync("/etc/hosts", join(skill, "linked"));

  mkdirSync(join(userDir, "commands"), { recursive: true });
  writeFileSync(join(userDir, "commands", "ship.md"), "command\n");
  writeFileSync(join(userDir, "CLAUDE.md"), "memory\n");
  writeFileSync(
    join(userDir, "settings.json"),
    JSON.stringify({
      model: "opus",
      apiKeyHelper: PLANTED.helper,
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "prettier --write" }] }],
        Stop: [{ hooks: [{ type: "command", command: PLANTED.hookSecret }] }],
      },
    }),
  );
  writeFileSync(
    join(userDir, ".claude.json"),
    JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }),
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function plan(confirmedHooks = []) {
  return collectExport({
    userDir,
    claudeJsonPath: join(userDir, ".claude.json"),
    confirmedHooks,
  });
}

test("bundle contains the portable tree and manifest hashes match content", () => {
  const result = plan();
  const paths = result.entries.map((entry) => entry.path);
  assert.deepEqual(paths, [
    "CLAUDE.md",
    "commands/ship.md",
    "settings.json",
    "skills/reviewer/SKILL.md",
    "skills/reviewer/references/guide.md",
    "skills/reviewer/run.sh",
  ]);
  for (const file of result.manifest.files) {
    const entry = result.entries.find((candidate) => candidate.path === file.path);
    assert.equal(createHash("sha256").update(entry.content).digest("hex"), file.sha256);
    assert.equal(entry.content.length, file.size);
  }
});

test("credential-pattern files, symlinks and unrepresentable paths are skipped with reasons", () => {
  const result = plan();
  const skippedPaths = result.skipped.map((entry) => entry.path).sort();
  assert.deepEqual(skippedPaths, [
    "skills/reviewer/.env",
    "skills/reviewer/cert.pem",
    "skills/reviewer/id_ed25519_sk",
    "skills/reviewer/id_rsa",
    "skills/reviewer/id_rsa.bak",
    "skills/reviewer/linked",
    `skills/reviewer/${LONG_NAME}`,
    "skills/reviewer/server.key",
  ]);
  const longSkip = result.skipped.find((entry) => entry.path.endsWith(LONG_NAME));
  assert.match(longSkip.reason, /too long/);
});

test("executables keep their bit deterministically, in manifest and directory export", () => {
  const result = plan();
  const script = result.manifest.files.find((file) => file.path === "skills/reviewer/run.sh");
  assert.equal(script.executable, true);
  assert.equal(result.manifest.files.find((file) => file.path === "CLAUDE.md").executable, undefined);
});

test("no planted secret reaches the plan, in files or manifest", () => {
  const result = plan();
  const everything =
    JSON.stringify(result.manifest) + result.entries.map((entry) => entry.content.toString("latin1")).join("");
  for (const [label, value] of Object.entries(PLANTED)) {
    assert.ok(!everything.includes(value), `plan leaked ${label}`);
  }
});

test("hooks stay out unless confirmed one by one", () => {
  const withoutHooks = plan();
  assert.deepEqual(
    withoutHooks.manifest.hooks,
    [
      { name: "hooks.PostToolUse", included: false },
      { name: "hooks.Stop", included: false },
    ],
  );
  const settings = JSON.parse(withoutHooks.entries.find((entry) => entry.path === "settings.json").content);
  assert.deepEqual(settings, { model: "opus" });

  const withHook = plan(["hooks.PostToolUse"]);
  const confirmed = JSON.parse(withHook.entries.find((entry) => entry.path === "settings.json").content);
  assert.deepEqual(Object.keys(confirmed.hooks), ["PostToolUse"]);
  assert.ok(!JSON.stringify(confirmed).includes(PLANTED.hookSecret));
});

test("an unknown --hook name is an error", () => {
  const result = plan(["hooks.DoesNotExist"]);
  assert.ok(result.diagnostics.some((d) => d.severity === "error"));
});

test("tar export is deterministic and readable by system tar", () => {
  const first = join(root, "a.tar");
  const second = join(root, "b.tar");
  runCli(["export", first]);
  runCli(["export", second]);
  assert.ok(readFileSync(first).equals(readFileSync(second)), "two exports differ byte for byte");

  const listing = execFileSync("tar", ["-tf", first], { encoding: "utf8" }).trim().split("\n").sort();
  assert.ok(listing.includes("manifest.json"));
  assert.ok(listing.includes("files/skills/reviewer/SKILL.md"));
  assert.ok(listing.includes("files/CLAUDE.md"));
});

test("gzip export is deterministic and stdout export matches the tar file", () => {
  const first = join(root, "a.tgz");
  const second = join(root, "b.tgz");
  runCli(["export", first]);
  runCli(["export", second]);
  assert.ok(readFileSync(first).equals(readFileSync(second)));

  const plain = readFileSync(join(root, "a.tar"));
  const streamed = runCli(["export", "-"]);
  assert.ok(streamed.equals(plain), "stdout stream must be exactly the tar bytes, nothing else");
});

test("directory export writes manifest and files tree", () => {
  const dest = join(root, "bundle-dir");
  runCli(["export", dest]);
  const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(readFileSync(join(dest, "files", "CLAUDE.md"), "utf8"), "memory\n");
});

test("dry run writes nothing and needs no destination", () => {
  const output = runCli(["export", "--dry-run"]).toString("utf8");
  assert.match(output, /Would pack 6 files/);
  assert.match(output, /hooks\.PostToolUse — left behind/);
});

test("tar, dir and dry-run all agree on skipping the unrepresentable file", () => {
  const listing = execFileSync("tar", ["-tf", join(root, "a.tar")], { encoding: "utf8" });
  assert.ok(!listing.includes(LONG_NAME));
  const dryRun = runCli(["export", "--dry-run"]).toString("utf8");
  assert.ok(!dryRun.includes(`Would pack`) || !dryRun.split("Skipped:")[0].includes(LONG_NAME));
  assert.ok(dryRun.split("Skipped:")[1].includes(LONG_NAME));
});

test("json output carries skipped entries and diagnostics", () => {
  const payload = JSON.parse(runCli(["export", "--dry-run", "--json"]).toString("utf8"));
  assert.ok(Array.isArray(payload.skipped));
  assert.ok(payload.skipped.some((entry) => entry.path.endsWith("server.key")));
  assert.ok(Array.isArray(payload.diagnostics));
});

test("a manifest-only bundle is legal when only MCP metadata exists", () => {
  const altRoot = mkdtempSync(join(tmpdir(), "agent-sync-manifestonly-"));
  try {
    const altUser = join(altRoot, ".claude");
    mkdirSync(altUser, { recursive: true });
    writeFileSync(
      join(altUser, ".claude.json"),
      JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }),
    );
    const dest = join(altRoot, "bundle");
    execFileSync(process.execPath, ["bin/agent-sync.mjs", "export", dest], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_CONFIG_DIR: altUser },
    });
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    assert.equal(manifest.files.length, 0);
    assert.equal(manifest.mcpServers[0].name, "linear");
  } finally {
    rmSync(altRoot, { recursive: true, force: true });
  }
});

test("filesystem errors exit 2 with a clean message, not a stack trace", () => {
  try {
    runCli(["export", join(root, "no-such-parent", "out.tar")]);
    assert.fail("expected a non-zero exit");
  } catch (error) {
    assert.equal(error.status, 2);
    const stderr = error.stderr.toString("utf8");
    assert.match(stderr, /^export: /m);
    assert.ok(!stderr.includes("    at "), "stack trace leaked to the user");
  }
});
