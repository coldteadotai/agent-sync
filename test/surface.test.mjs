import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALL_COMMANDS, GLOBAL_FLAGS, runCli, usage } from "../dist/main.js";

function capture() {
  const out = [];
  const err = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

test("public surface is frozen", () => {
  assert.deepEqual(Object.keys(GLOBAL_FLAGS).sort(), ["help", "version"]);
  assert.deepEqual(ALL_COMMANDS.map((command) => command.word), ["scan", "export", "apply", "undo"]);
  assert.deepEqual(Object.keys(ALL_COMMANDS[0].flags).sort(), ["json", "no-project", "project"]);
  assert.deepEqual(Object.keys(ALL_COMMANDS[1].flags).sort(), ["allow-secret", "dry-run", "hook", "json", "plugin", "skip"]);
  assert.deepEqual(Object.keys(ALL_COMMANDS[2].flags).sort(), ["dry-run", "hook", "mcp", "no-input", "plain", "plugin", "target"]);
  assert.deepEqual(Object.keys(ALL_COMMANDS[3].flags).sort(), ["target"]);
});

test("help wins when combined with version", async () => {
  const { io, out } = capture();
  assert.equal(await runCli(["--version", "--help"], io), 0);
  assert.equal(out[0], usage());
});

test("bare double-dash with positionals exits 2", async () => {
  const { io } = capture();
  assert.equal(await runCli(["--", "foo"], io), 2);
});

test("--version prints a semver", async () => {
  const { io, out, err } = capture();
  assert.equal(await runCli(["--version"], io), 0);
  assert.equal(out.length, 1);
  assert.match(out[0], /^\d+\.\d+\.\d+$/);
  assert.equal(err.length, 0);
});

test("no arguments prints usage and exits 0", async () => {
  const { io, out } = capture();
  assert.equal(await runCli([], io), 0);
  assert.equal(out[0], usage());
});

test("--help prints usage and exits 0", async () => {
  const { io, out } = capture();
  assert.equal(await runCli(["--help"], io), 0);
  assert.equal(out[0], usage());
});

test("unknown flag exits 2 with usage on stderr", async () => {
  const { io, out, err } = capture();
  assert.equal(await runCli(["--bogus"], io), 2);
  assert.equal(out.length, 0);
  assert.ok(err.length >= 2);
});

test("single-dash short flags are rejected", async () => {
  const { io } = capture();
  assert.equal(await runCli(["-h"], io), 2);
});

test("bin wiring works end to end", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const output = execFileSync(process.execPath, ["bin/agent-sync.mjs", "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(output.trim(), /^\d+\.\d+\.\d+$/);
});

test("unknown command exits 2 and names it", async () => {
  const { io, err } = capture();
  assert.equal(await runCli(["teleport"], io), 2);
  assert.match(err[0], /Unknown command: teleport/);
});
