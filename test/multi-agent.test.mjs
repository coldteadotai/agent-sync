import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHookGroup,
  buildTravelGroups,
  collectExport,
  loadBundleFromBuffer,
  planApply,
  scanClaudeCode,
  scanCodex,
  scanOpencode,
  splitBundleByRoot,
} from "../dist/main.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

let root;
let sourceHome;
let userDir;

function seedSourceHome() {
  userDir = join(sourceHome, ".claude");
  mkdirSync(join(userDir, "skills", "reviewer"), { recursive: true });
  writeFileSync(join(userDir, "skills", "reviewer", "SKILL.md"), "# reviewer\n");
  writeFileSync(join(userDir, "CLAUDE.md"), "claude memory\n");
  writeFileSync(join(userDir, "settings.json"), JSON.stringify({ model: "opus" }));
  writeFileSync(join(userDir, ".claude.json"), JSON.stringify({ mcpServers: {} }));

  const codexHome = join(sourceHome, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    'model = "gpt-5-codex"\nmodel_reasoning_effort = "high"\npersonal_note = "stays behind"\n',
  );
  writeFileSync(join(codexHome, "AGENTS.md"), "codex memory\n");
  writeFileSync(join(codexHome, "auth.json"), "planted-codex-credential");

  mkdirSync(join(sourceHome, ".agents", "skills", "hermes"), { recursive: true });
  writeFileSync(join(sourceHome, ".agents", "skills", "hermes", "SKILL.md"), "# hermes\n");

  const opencodeDir = join(sourceHome, ".config", "opencode", "commands");
  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(join(opencodeDir, "deploy.md"), "opencode command\n");
  writeFileSync(
    join(sourceHome, ".config", "opencode", "opencode.json"),
    JSON.stringify({ model: "anthropic/claude", theme: "dark", keybinds: { stays: "behind" } }),
  );
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-multi-"));
  sourceHome = join(root, "source-home");
  seedSourceHome();
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function collect(options = {}) {
  return collectExport({
    userDir,
    claudeJsonPath: join(userDir, ".claude.json"),
    codexHome: join(sourceHome, ".codex"),
    codexAgentsDir: join(sourceHome, ".agents"),
    opencodeConfigDir: join(sourceHome, ".config", "opencode"),
    ...options,
  });
}

test("a multi-agent export namespaces files, unions agents, and bumps to schema 2", () => {
  const plan = collect();
  assert.deepEqual(
    plan.entries.map((entry) => entry.path),
    [
      "CLAUDE.md",
      "codex/AGENTS.md",
      "codex/config.toml",
      "codex/skills/hermes/SKILL.md",
      "opencode/commands/deploy.md",
      "opencode/opencode.json",
      "settings.json",
      "skills/reviewer/SKILL.md",
    ],
  );
  assert.equal(plan.manifest.schemaVersion, 2);
  assert.deepEqual(plan.manifest.agents, ["claude-code", "codex", "opencode"]);

  const toml = plan.entries.find((entry) => entry.path === "codex/config.toml").content.toString();
  assert.equal(toml, 'model = "gpt-5-codex"\nmodel_reasoning_effort = "high"\n');
  assert.ok(!toml.includes("personal_note"), "non-portable codex key leaked");

  const opencode = JSON.parse(plan.entries.find((entry) => entry.path === "opencode/opencode.json").content);
  assert.deepEqual(opencode, { model: "anthropic/claude", theme: "dark" });

  const everything = JSON.stringify(plan.manifest) + plan.entries.map((entry) => entry.content.toString("latin1")).join("");
  assert.ok(!everything.includes("planted-codex-credential"), "codex auth.json leaked");
});

test("a claude-only export stays schema 1 with no agents field, bit-compatible with v1", () => {
  const empty = join(root, "empty-home");
  mkdirSync(empty, { recursive: true });
  const plan = collect({
    codexHome: join(empty, ".codex"),
    codexAgentsDir: join(empty, ".agents"),
    opencodeConfigDir: join(empty, ".config", "opencode"),
  });
  assert.equal(plan.manifest.schemaVersion, 1);
  assert.equal(plan.manifest.agents, undefined);
  assert.ok(plan.entries.every((entry) => !entry.path.startsWith("codex/") && !entry.path.startsWith("opencode/")));
});

test("agent-prefixed and whole-agent skip tokens work and validate", () => {
  const noCodex = collect({ skips: ["codex"] });
  assert.ok(noCodex.entries.every((entry) => !entry.path.startsWith("codex/")));
  assert.equal(noCodex.manifest.schemaVersion, 2, "opencode content still bumps the schema");

  const oneOut = collect({ skips: ["codex/skill/hermes", "opencode/command/deploy"] });
  const paths = oneOut.entries.map((entry) => entry.path);
  assert.ok(!paths.includes("codex/skills/hermes/SKILL.md"));
  assert.ok(!paths.includes("opencode/commands/deploy.md"));
  assert.ok(paths.includes("codex/AGENTS.md"));

  assert.ok(collect({ skips: ["codex/skill/nope"] }).diagnostics.some((d) => d.severity === "error"));
  const empty = join(root, "empty-home-2");
  mkdirSync(empty, { recursive: true });
  const absentAgent = collect({
    codexHome: join(empty, ".codex"),
    codexAgentsDir: join(empty, ".agents"),
    skips: ["codex"],
  });
  assert.ok(
    absentAgent.diagnostics.some((d) => d.severity === "error"),
    "skipping an absent agent must be an unknown-token error",
  );
});

test("splitBundleByRoot rebases each namespace onto its own root, claude first", () => {
  const plan = collect();
  const bundle = {
    manifest: plan.manifest,
    files: new Map(plan.entries.map((entry) => [entry.path, { content: entry.content, executable: entry.executable }])),
  };
  const roots = {
    claude: "/t/claude",
    codexHome: "/t/codex-home",
    codexAgents: "/t/agents",
    opencodeConfig: "/t/opencode",
  };
  const slices = splitBundleByRoot(bundle, roots);
  assert.deepEqual(
    slices.map((slice) => [slice.agent, slice.root, [...slice.bundle.files.keys()].sort()]),
    [
      ["claude-code", "/t/claude", ["CLAUDE.md", "settings.json", "skills/reviewer/SKILL.md"]],
      ["codex", "/t/agents", ["skills/hermes/SKILL.md"]],
      ["codex", "/t/codex-home", ["AGENTS.md", "config.toml"]],
      ["opencode", "/t/opencode", ["commands/deploy.md", "opencode.json"]],
    ],
  );
  for (const slice of slices) {
    assert.deepEqual(
      slice.bundle.manifest.files.map((file) => file.path).sort(),
      [...slice.bundle.files.keys()].sort(),
      "slice manifest must describe exactly the slice files",
    );
  }
});

function cliEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
}

test("multi-agent apply lands each namespace in its own root, and undo sweeps them all", () => {
  const bundlePath = join(root, "multi.tgz");
  execFileSync(process.execPath, ["bin/agent-sync.mjs", "export", bundlePath], {
    cwd: REPO_ROOT,
    env: cliEnv(sourceHome),
  });

  const applyHome = join(root, "apply-home");
  mkdirSync(join(applyHome, ".claude"), { recursive: true });
  const output = execFileSync(process.execPath, ["bin/agent-sync.mjs", "apply", bundlePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: cliEnv(applyHome),
  });
  assert.match(output, /Done: 8 created, 0 updated/);

  assert.equal(readFileSync(join(applyHome, ".claude", "CLAUDE.md"), "utf8"), "claude memory\n");
  assert.equal(readFileSync(join(applyHome, ".codex", "AGENTS.md"), "utf8"), "codex memory\n");
  assert.match(readFileSync(join(applyHome, ".codex", "config.toml"), "utf8"), /model = "gpt-5-codex"/);
  assert.ok(existsSync(join(applyHome, ".agents", "skills", "hermes", "SKILL.md")));
  assert.ok(existsSync(join(applyHome, ".config", "opencode", "commands", "deploy.md")));
  for (const marked of [".claude", ".codex", ".agents", join(".config", "opencode")]) {
    assert.ok(existsSync(join(applyHome, marked, ".agent-sync", "last-applied.json")), `${marked} has no marker`);
  }

  const undoOut = execFileSync(process.execPath, ["bin/agent-sync.mjs", "undo"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: cliEnv(applyHome),
  });
  assert.ok(!existsSync(join(applyHome, ".claude", "CLAUDE.md")));
  assert.ok(!existsSync(join(applyHome, ".codex", "AGENTS.md")));
  assert.ok(!existsSync(join(applyHome, ".agents", "skills", "hermes", "SKILL.md")));
  assert.ok(!existsSync(join(applyHome, ".config", "opencode", "opencode.json")));
  assert.equal((undoOut.match(/removed \d+ created file\(s\)/g) ?? []).length, 4, "undo must report all four roots");
});

test("per-agent settings allowlists refuse namespaced configs with unknown keys", async () => {
  const craft = (name, files) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "files"), { recursive: true });
    const manifest = { schemaVersion: 2, tool: "agent-sync", agent: "claude-code", files: [], mcpServers: [], hooks: [] };
    for (const [path, content] of Object.entries(files)) {
      const bytes = Buffer.from(content);
      const target = join(dir, "files", ...path.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, bytes);
      manifest.files.push({ path, sha256: sha256(bytes), size: bytes.length });
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    return dir;
  };
  const applyDir = (dir) => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    try {
      execFileSync(process.execPath, ["bin/agent-sync.mjs", "apply", dir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: cliEnv(home),
      });
      return { status: 0, home };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr), home };
    }
  };

  const codexBad = applyDir(craft("bad-codex", { "codex/config.toml": 'api_key = "x"\n' }));
  assert.equal(codexBad.status, 2);
  assert.match(codexBad.stderr, /codex\/config\.toml carries "api_key"/);
  assert.ok(!existsSync(join(codexBad.home, ".codex", "config.toml")));

  const opencodeBad = applyDir(craft("bad-opencode", { "opencode/opencode.json": '{"mcp":{"x":{}}}' }));
  assert.equal(opencodeBad.status, 2);
  assert.match(opencodeBad.stderr, /opencode\/opencode\.json carries "mcp"/);

  const codexUnparsed = applyDir(craft("bad-toml", { "codex/config.toml": "= broken =\n" }));
  assert.equal(codexUnparsed.status, 2);
  assert.match(codexUnparsed.stderr, /not parseable TOML/);

  const badPath = applyDir(craft("bad-ns-path", { "codex/sessions/history.jsonl": "x" }));
  assert.equal(badPath.status, 2);
  assert.match(badPath.stderr, /not a path agent-sync exports/);
});

test("symlink containment holds per agent root", () => {
  const plan = collect();
  const bundle = {
    manifest: plan.manifest,
    files: new Map(plan.entries.map((entry) => [entry.path, { content: entry.content, executable: entry.executable }])),
  };
  const hostile = join(root, "hostile-codex-home");
  const outside = join(root, "hostile-outside");
  mkdirSync(hostile, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(hostile, "AGENTS.md"));
  const roots = {
    claude: join(root, "hostile-claude"),
    codexHome: hostile,
    codexAgents: join(root, "hostile-agents"),
    opencodeConfig: join(root, "hostile-opencode"),
  };
  const slice = splitBundleByRoot(bundle, roots).find((candidate) => candidate.root === hostile);
  assert.throws(() => planApply(slice.bundle, slice.root), /symlink inside the target/);
});

test("the travel picker shows agent groups only when the agent has candidates", () => {
  const claude = scanClaudeCode({ userDir, projectDir: null, claudeJsonPath: join(userDir, ".claude.json") });
  const codex = scanCodex({ codexHome: join(sourceHome, ".codex"), agentsDir: join(sourceHome, ".agents"), projectDir: null });
  const opencode = scanOpencode({ configDir: join(sourceHome, ".config", "opencode"), projectDir: null });

  const withBoth = buildTravelGroups(claude, [codex, opencode]);
  const titles = withBoth.map((group) => group.title);
  assert.ok(titles.includes("Codex"));
  assert.ok(titles.includes("OpenCode"));
  const codexGroup = withBoth.find((group) => group.title === "Codex");
  assert.deepEqual(
    codexGroup.items.map((item) => item.value).sort(),
    ["codex/memory/AGENTS.md", "codex/settings", "codex/skill/hermes"],
  );

  const empty = join(root, "empty-home-3");
  mkdirSync(empty, { recursive: true });
  const absent = buildTravelGroups(claude, [
    scanCodex({ codexHome: join(empty, ".codex"), agentsDir: join(empty, ".agents"), projectDir: null }),
    scanOpencode({ configDir: join(empty, ".config", "opencode"), projectDir: null }),
  ]);
  assert.ok(absent.every((group) => group.title !== "Codex" && group.title !== "OpenCode"));
  assert.equal(buildHookGroup(claude), null);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

