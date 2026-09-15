import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCodex } from "../dist/main.js";

const PLANTED = {
  authToken: "codex-planted-auth-token",
  apiKey: "codex-planted-api-key",
  mcpEnv: "codex-planted-env-value",
};

let root;
let report;

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-codex-"));
  const codexHome = join(root, ".codex");
  const agentsDir = join(root, ".agents");
  const projectDir = join(root, "project");

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model = "gpt-5-codex"',
      'model_reasoning_effort = "high"',
      `api_key = "${PLANTED.apiKey}"`,
      "",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      "",
      "[mcp_servers.local]",
      'command = "npx"',
      'args = ["-y", "some-mcp"]',
      `env = { LOCAL_TOKEN = "${PLANTED.mcpEnv}" }`,
    ].join("\n"),
  );
  writeFileSync(join(codexHome, "AGENTS.md"), "codex memory\n");
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ token: PLANTED.authToken }));
  mkdirSync(join(codexHome, "sessions", "abc"), { recursive: true });

  mkdirSync(join(agentsDir, "skills", "shipping"), { recursive: true });
  writeFileSync(join(agentsDir, "skills", "shipping", "SKILL.md"), "# shipping\n");
  mkdirSync(join(agentsDir, "skills", "no-manifest"), { recursive: true });

  mkdirSync(join(projectDir, ".codex"), { recursive: true });
  writeFileSync(join(projectDir, ".codex", "config.toml"), 'model = "gpt-5-codex"');
  writeFileSync(join(projectDir, "AGENTS.md"), "project memory\n");

  report = scanCodex({ codexHome, agentsDir, projectDir });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function item(name, scope = "user") {
  const found = report.items.find((candidate) => candidate.name === name && candidate.scope === scope);
  assert.ok(found, `expected item ${scope}/${name}`);
  return found;
}

test("no planted secret appears anywhere in the codex report", () => {
  const serialized = JSON.stringify(report);
  for (const [label, value] of Object.entries(PLANTED)) {
    assert.ok(!serialized.includes(value), `report leaked ${label}`);
  }
  assert.ok(!serialized.includes("api_key"), "sensitive key names stay out of portable settings");
});

test("portable config keys are allowlisted, memory and skills are candidates", () => {
  assert.equal(item("config.toml (model, model_reasoning_effort)").status, "candidate");
  assert.equal(item("AGENTS.md").kind, "memory");
  assert.equal(item("shipping").kind, "skill");
  assert.ok(!report.items.some((entry) => entry.name === "no-manifest"));
});

test("codex mcp servers classify with the shared classifier", () => {
  const linear = item("linear");
  assert.equal(linear.status, "candidate");
  assert.equal(linear.url, "https://mcp.linear.app/mcp");
  const local = item("local");
  assert.equal(local.status, "blocked");
  assert.deepEqual(local.envRefs, ["LOCAL_TOKEN"]);
});

test("project scope picks up config and root AGENTS.md", () => {
  assert.equal(item("config.toml (model)", "project").status, "candidate");
  assert.equal(item("AGENTS.md", "project").kind, "memory");
});

test("credentials and sessions land in excluded", () => {
  const excluded = report.excluded.map((entry) => entry.path);
  assert.ok(excluded.some((path) => path.endsWith("auth.json")));
  assert.ok(excluded.some((path) => path.endsWith("sessions")));
});

test("an absent codex install reports present: false with no items", () => {
  const empty = scanCodex({
    codexHome: join(root, "nope-codex"),
    agentsDir: join(root, "nope-agents"),
    projectDir: null,
  });
  assert.equal(empty.present, false);
  assert.deepEqual(empty.items, []);
});

test("a malformed config.toml warns without leaking content", () => {
  const badRoot = mkdtempSync(join(tmpdir(), "agent-sync-codex-bad-"));
  try {
    const codexHome = join(badRoot, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'model = "ok"\ntoken = planted-toml-secret');
    const bad = scanCodex({ codexHome, agentsDir: join(badRoot, ".agents"), projectDir: null });
    assert.equal(bad.diagnostics.filter((d) => d.severity === "warning").length, 1);
    assert.ok(!JSON.stringify(bad).includes("planted-toml-secret"));
  } finally {
    rmSync(badRoot, { recursive: true, force: true });
  }
});
