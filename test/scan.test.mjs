import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanClaudeCode } from "../dist/main.js";

const PLANTED = {
  oauthToken: "oauth-planted-value-1234",
  apiHelper: "sk-planted-helper-value",
  mcpHeader: "Bearer planted-header-value",
  mcpEnv: "planted-env-value",
  credential: "planted-credential-value",
  history: "planted-history-value",
  dollarSecret: "abc$PlantedDollarTail",
};

let root;
let report;

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-scan-"));
  const userDir = join(root, ".claude");
  const projectDir = join(root, "project");

  mkdirSync(join(userDir, "skills", "reviewer"), { recursive: true });
  writeFileSync(join(userDir, "skills", "reviewer", "SKILL.md"), "# reviewer\n");
  mkdirSync(join(userDir, "skills", "planner"), { recursive: true });
  writeFileSync(join(userDir, "skills", "planner", "SKILL.md"), "# planner\n");
  mkdirSync(join(userDir, "skills", "broken-no-manifest"), { recursive: true });
  writeFileSync(join(userDir, "skills", ".DS_Store"), "");

  mkdirSync(join(userDir, "agents"), { recursive: true });
  writeFileSync(join(userDir, "agents", "tester.md"), "agent\n");
  mkdirSync(join(userDir, "commands"), { recursive: true });
  writeFileSync(join(userDir, "commands", "ship.md"), "command\n");
  writeFileSync(join(userDir, "CLAUDE.md"), "memory\n");

  writeFileSync(
    join(userDir, "settings.json"),
    JSON.stringify({
      model: "opus",
      theme: "dark",
      apiKeyHelper: PLANTED.apiHelper,
      statusLine: { type: "command", command: "/usr/local/bin/status.sh" },
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "notify.sh" }] }] },
    }),
  );
  writeFileSync(join(userDir, ".credentials.json"), JSON.stringify({ token: PLANTED.credential }));
  mkdirSync(join(userDir, "projects", "some-session"), { recursive: true });

  writeFileSync(
    join(root, ".claude.json"),
    JSON.stringify({
      oauthAccount: { accessToken: PLANTED.oauthToken },
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        corp: {
          url: "https://mcp.corp.example.com/sse",
          headers: { Authorization: PLANTED.mcpHeader },
          env: { CORP_TOKEN: PLANTED.mcpEnv },
        },
        localtool: { command: "node", args: ["./tool/index.js"] },
        devproxy: { url: "http://127.0.0.1:9000/mcp" },
        dollar: {
          url: "https://mcp.dollar.example.com/mcp",
          headers: { Authorization: PLANTED.dollarSecret },
        },
      },
      projects: {
        "/Users/someone/work": {
          history: [{ display: PLANTED.history }],
          mcpServers: {
            nestedremote: { type: "http", url: "https://mcp.nested.example.com/mcp" },
            nestedlocal: { command: "python3", args: ["serve.py"] },
          },
        },
      },
    }),
  );

  mkdirSync(join(projectDir, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(projectDir, ".claude", "skills", "deploy", "SKILL.md"), "# deploy\n");
  writeFileSync(join(projectDir, "CLAUDE.md"), "project memory\n");
  writeFileSync(join(projectDir, ".claude", "settings.local.json"), JSON.stringify({ model: "haiku" }));
  writeFileSync(
    join(projectDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { shared: { type: "http", url: "https://mcp.example.com/mcp" } } }),
  );

  report = scanClaudeCode({
    userDir,
    projectDir,
    claudeJsonPath: join(root, ".claude.json"),
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function item(name, scope = "user") {
  const found = report.items.find((candidate) => candidate.name === name && candidate.scope === scope);
  assert.ok(found, `expected item ${scope}/${name}`);
  return found;
}

test("no planted secret value appears anywhere in the report", () => {
  const serialized = JSON.stringify(report);
  for (const [label, value] of Object.entries(PLANTED)) {
    assert.ok(!serialized.includes(value), `report leaked ${label}`);
  }
});

test("skills need a SKILL.md and dotfiles are ignored", () => {
  assert.equal(item("reviewer").status, "candidate");
  assert.equal(item("planner").status, "candidate");
  const names = report.items.map((entry) => entry.name);
  assert.ok(!names.includes("broken-no-manifest"));
  assert.ok(!names.includes(".DS_Store"));
});

test("subagents, commands and memory are candidates", () => {
  assert.equal(item("tester").kind, "subagent");
  assert.equal(item("ship").kind, "command");
  assert.equal(item("CLAUDE.md").kind, "memory");
});

test("settings keep only portable allowlisted keys", () => {
  const settings = item("settings.json (model, theme)");
  assert.equal(settings.status, "candidate");
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("apiKeyHelper"));
});

test("statusLine and hooks are blocked pending per-item confirmation", () => {
  assert.equal(item("settings.statusLine").status, "blocked");
  assert.equal(item("hooks.PostToolUse").status, "blocked");
});

test("mcp servers are classified without values", () => {
  assert.equal(item("linear").status, "candidate");
  const corp = item("corp");
  assert.equal(corp.status, "needs_secret");
  assert.deepEqual(corp.envRefs, ["CORP_TOKEN"]);
  assert.equal(item("localtool").status, "blocked");
  assert.equal(item("devproxy").status, "blocked");
});

test("local-scope servers nested under projects are found", () => {
  assert.equal(item("nestedremote").status, "candidate");
  // python3 serve.py resolves against a working directory that only exists
  // here, so the bare-script guard keeps it blocked.
  assert.equal(item("nestedlocal").status, "blocked");
  assert.equal(item("nestedlocal").stdio, undefined);
});

test("a dollar sign inside a secret value never emits a fragment env ref", () => {
  const dollar = item("dollar");
  assert.equal(dollar.status, "needs_secret");
  assert.equal(dollar.envRefs, undefined);
});

test("project memory is read from the repo root", () => {
  assert.equal(item("CLAUDE.md", "project").kind, "memory");
});

test("a missing --project path warns instead of reporting silently clean", () => {
  const missing = scanClaudeCode({
    userDir: join(root, ".claude"),
    projectDir: join(root, "does-not-exist"),
    claudeJsonPath: join(root, ".claude.json"),
  });
  assert.ok(
    missing.diagnostics.some(
      (d) => d.severity === "warning" && d.message.includes("does-not-exist"),
    ),
  );
});

test("CLAUDE_CONFIG_DIR moves both the config dir and .claude.json", () => {
  const altRoot = mkdtempSync(join(tmpdir(), "agent-sync-configdir-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    mkdirSync(join(altRoot, "confdir"), { recursive: true });
    writeFileSync(
      join(altRoot, "confdir", ".claude.json"),
      JSON.stringify({ mcpServers: { moved: { type: "http", url: "https://mcp.moved.example.com" } } }),
    );
    process.env.CLAUDE_CONFIG_DIR = join(altRoot, "confdir");
    const moved = scanClaudeCode({ projectDir: null });
    assert.equal(moved.userDir, join(altRoot, "confdir"));
    assert.ok(moved.items.some((entry) => entry.name === "moved"));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(altRoot, { recursive: true, force: true });
  }
});

test("project scope picks up skills and shared mcp config", () => {
  assert.equal(item("deploy", "project").kind, "skill");
  assert.equal(item("shared", "project").status, "candidate");
});

test("credential and history paths land in excluded, settings.local.json too", () => {
  const excluded = report.excluded.map((entry) => entry.path);
  assert.ok(excluded.some((path) => path.endsWith(".credentials.json")));
  assert.ok(excluded.some((path) => path.endsWith(".claude.json")));
  assert.ok(excluded.some((path) => path.endsWith("projects")));
  assert.ok(excluded.some((path) => path.endsWith("settings.local.json")));
});

test("a malformed config never leaks its content through parse diagnostics", () => {
  const badRoot = mkdtempSync(join(tmpdir(), "agent-sync-badjson-"));
  try {
    const userDir = join(badRoot, ".claude");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(badRoot, ".claude.json"), '{"oauthToken": planted-badjson-secret}');
    writeFileSync(join(userDir, "settings.json"), '{"model": planted-badsettings-secret}');
    const badReport = scanClaudeCode({
      userDir,
      projectDir: null,
      claudeJsonPath: join(badRoot, ".claude.json"),
    });
    const serialized = JSON.stringify(badReport);
    assert.ok(!serialized.includes("planted-badjson-secret"));
    assert.ok(!serialized.includes("planted-badsettings-secret"));
    assert.equal(badReport.diagnostics.filter((d) => d.severity === "warning").length, 2);
  } finally {
    rmSync(badRoot, { recursive: true, force: true });
  }
});

test("scan produced no error diagnostics on the fixture", () => {
  assert.deepEqual(report.diagnostics.filter((d) => d.severity === "error"), []);
});
