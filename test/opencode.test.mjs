import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOpencode, stripJsonc } from "../dist/main.js";

const PLANTED = {
  authToken: "opencode-planted-auth-token",
  apiKey: "opencode-planted-api-key",
  mcpEnv: "opencode-planted-env-value",
};

let root;
let report;

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-opencode-"));
  const configDir = join(root, "config", "opencode");
  const dataDir = join(root, "share", "opencode");
  const projectDir = join(root, "project");

  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "opencode.jsonc"),
    [
      "{",
      "  // model preference",
      '  "model": "anthropic/claude-sonnet-5",',
      '  "theme": "tokyonight",',
      `  "apiKey": "${PLANTED.apiKey}",`,
      '  "mcp": {',
      '    "linear": { "type": "remote", "url": "https://mcp.linear.app/mcp" },',
      '    "local": {',
      '      "type": "local",',
      '      "command": ["bun", "x", "my-mcp"],',
      `      "environment": { "LOCAL_TOKEN": "${PLANTED.mcpEnv}" },`,
      "    },",
      "  },",
      '  "plugin": ["opencode-plugin-notify"],',
      "}",
    ].join("\n"),
  );
  mkdirSync(join(configDir, "commands"), { recursive: true });
  writeFileSync(join(configDir, "commands", "ship.md"), "command\n");
  writeFileSync(
    join(configDir, "package.json"),
    JSON.stringify({ dependencies: { "@opencode-ai/plugin": "^1.0.0", left_pad: "1.0.0" } }),
  );
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "auth.json"), JSON.stringify({ token: PLANTED.authToken }));

  mkdirSync(join(projectDir, ".opencode", "agent"), { recursive: true });
  writeFileSync(join(projectDir, ".opencode", "agent", "tester.md"), "agent\n");

  report = scanOpencode({ configDir, dataDir, projectDir });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function item(name, scope = "user") {
  const found = report.items.find((candidate) => candidate.name === name && candidate.scope === scope);
  assert.ok(found, `expected item ${scope}/${name}`);
  return found;
}

test("no planted secret appears anywhere in the opencode report", () => {
  const serialized = JSON.stringify(report);
  for (const [label, value] of Object.entries(PLANTED)) {
    assert.ok(!serialized.includes(value), `report leaked ${label}`);
  }
});

test("jsonc config parses; portable keys allowlisted", () => {
  assert.equal(item("opencode.jsonc (model, theme)").status, "candidate");
});

test("opencode mcp entries classify with the shared engine", () => {
  assert.equal(item("linear").status, "candidate");
  assert.equal(item("linear").url, "https://mcp.linear.app/mcp");
  assert.equal(item("local").status, "blocked");
});

test("plugins from config, directory and npm all report blocked", () => {
  assert.equal(item("opencode-plugin-notify").status, "blocked");
  assert.equal(item("@opencode-ai/plugin").status, "blocked");
  assert.ok(!report.items.some((entry) => entry.name === "left_pad"));
});

test("commands and project agents are candidates; auth is excluded", () => {
  assert.equal(item("ship").kind, "command");
  assert.equal(item("tester", "project").kind, "subagent");
  assert.ok(report.excluded.some((entry) => entry.path.endsWith("auth.json")));
});

test("absent install reports present false", () => {
  const empty = scanOpencode({
    configDir: join(root, "nope-config"),
    dataDir: join(root, "nope-data"),
    projectDir: null,
  });
  assert.equal(empty.present, false);
  assert.deepEqual(empty.items, []);
});

test("stripJsonc leaves strings alone and only strips real comments and trailing commas", () => {
  const tricky = '{"url": "https://x.example.com/a//b", "note": "a,}", "list": [1, 2,], }';
  const parsed = JSON.parse(stripJsonc(tricky));
  assert.equal(parsed.url, "https://x.example.com/a//b");
  assert.equal(parsed.note, "a,}");
  assert.deepEqual(parsed.list, [1, 2]);
  const commented = '{ /* block */ "a": 1, // line\n "b": "// not a comment" }';
  assert.deepEqual(JSON.parse(stripJsonc(commented)), { a: 1, b: "// not a comment" });
});

test("when both config filename variants exist, only one is scanned", () => {
  const bothRoot = mkdtempSync(join(tmpdir(), "agent-sync-opencode-both-"));
  try {
    const configDir = join(bothRoot, "opencode");
    mkdirSync(configDir, { recursive: true });
    const config = JSON.stringify({
      model: "anthropic/claude-sonnet-5",
      mcp: { srv: { type: "remote", url: "https://mcp.srv.example.com/mcp" } },
    });
    writeFileSync(join(configDir, "opencode.json"), config);
    writeFileSync(join(configDir, "opencode.jsonc"), config);
    const both = scanOpencode({ configDir, dataDir: join(bothRoot, "share"), projectDir: null });
    assert.equal(both.items.filter((entry) => entry.name === "srv").length, 1);
    assert.equal(both.items.filter((entry) => entry.kind === "settings").length, 1);
    assert.match(both.items.find((entry) => entry.kind === "settings").name, /^opencode\.json /);
  } finally {
    rmSync(bothRoot, { recursive: true, force: true });
  }
});

test("a malformed config warns without leaking content", () => {
  const badRoot = mkdtempSync(join(tmpdir(), "agent-sync-opencode-bad-"));
  try {
    const configDir = join(badRoot, "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), '{"model": planted-oc-secret}');
    const bad = scanOpencode({ configDir, dataDir: join(badRoot, "share"), projectDir: null });
    assert.equal(bad.diagnostics.filter((d) => d.severity === "warning").length, 1);
    assert.ok(!JSON.stringify(bad).includes("planted-oc-secret"));
  } finally {
    rmSync(badRoot, { recursive: true, force: true });
  }
});
