import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTravelGroups,
  collectExport,
  createFlow,
  createTheme,
  flagEcho,
  loadBundleFromBuffer,
  planMcpRegistrations,
  runGuidedApply,
  scanClaudeCode,
  Screen,
} from "../dist/main.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const fakeHome = mkdtempSync(join(tmpdir(), "agent-sync-stdio-home-"));

const PLANTED_ENV_VALUE = "planted-ctx7-env-value-928374";

let root;
let userDir;
let claudeJsonPath;

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-stdio-"));
  userDir = join(root, ".claude");
  mkdirSync(join(userDir, "skills", "reviewer"), { recursive: true });
  writeFileSync(join(userDir, "skills", "reviewer", "SKILL.md"), "# reviewer\n");
  writeFileSync(join(userDir, "settings.json"), JSON.stringify({ model: "opus" }));
  claudeJsonPath = join(userDir, ".claude.json");
  writeFileSync(
    claudeJsonPath,
    JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        ctx7: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { CTX7_TOKEN: PLANTED_ENV_VALUE } },
        timeserver: { command: "uvx", args: ["mcp-time"] },
        pinned: { command: "node", args: ["/Users/someone/tool.js"] },
      },
    }),
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function collect(options = {}) {
  return collectExport({
    userDir,
    claudeJsonPath,
    codexHome: join(fakeHome, ".codex"),
    codexAgentsDir: join(fakeHome, ".agents"),
    opencodeConfigDir: join(fakeHome, ".config", "opencode"),
    ...options,
  });
}

test("classification: portable stdio carries structure, env values die at extraction, pinned stays blocked", () => {
  const report = scanClaudeCode({ userDir, projectDir: null, claudeJsonPath });
  const byName = (name) => report.items.find((item) => item.name === name);

  const ctx7 = byName("ctx7");
  assert.equal(ctx7.status, "needs_secret");
  assert.deepEqual(ctx7.stdio, { command: "npx", args: ["-y", "@upstash/context7-mcp"], envNames: ["CTX7_TOKEN"] });

  const timeserver = byName("timeserver");
  assert.equal(timeserver.status, "candidate");
  assert.deepEqual(timeserver.stdio, { command: "uvx", args: ["mcp-time"], envNames: [] });

  assert.equal(byName("pinned").status, "blocked");
  assert.equal(byName("pinned").stdio, undefined);

  assert.ok(!JSON.stringify(report).includes(PLANTED_ENV_VALUE), "an env VALUE escaped classification");
});

test("export: stdio structure travels only behind --mcp, and values never reach the manifest", () => {
  const withoutConsent = collect();
  const ctx7 = withoutConsent.manifest.mcpServers.find((server) => server.name === "ctx7");
  assert.equal(ctx7.command, undefined, "structure must not travel without --mcp");

  const consented = collect({ selectedMcp: ["ctx7", "timeserver"] });
  const packed = consented.manifest.mcpServers.find((server) => server.name === "ctx7");
  assert.equal(packed.transport, "stdio");
  assert.equal(packed.command, "npx");
  assert.deepEqual(packed.args, ["-y", "@upstash/context7-mcp"]);
  assert.deepEqual(packed.envNames, ["CTX7_TOKEN"]);
  const everything =
    JSON.stringify(consented.manifest) + consented.entries.map((entry) => entry.content.toString("latin1")).join("");
  assert.ok(!everything.includes(PLANTED_ENV_VALUE), "an env VALUE reached the export plan");

  assert.ok(collect({ selectedMcp: ["linear"] }).diagnostics.some((d) => d.severity === "error"),
    "remote servers are not --mcp consent targets at export");
  assert.ok(collect({ selectedMcp: ["nope"] }).diagnostics.some((d) => d.severity === "error"));
});

test("the travel picker gains an MCP group with command hints, and the flag echo spells --mcp", () => {
  const report = scanClaudeCode({ userDir, projectDir: null, claudeJsonPath });
  const groups = buildTravelGroups(report, []);
  const mcpGroup = groups.find((group) => group.title.startsWith("MCP servers"));
  assert.deepEqual(
    mcpGroup.items.map((item) => item.value).sort(),
    ["mcp/ctx7", "mcp/timeserver"],
  );
  const hint = mcpGroup.items.find((item) => item.value === "mcp/ctx7").hint;
  assert.match(hint, /npx -y @upstash\/context7-mcp \(needs CTX7_TOKEN\)/);
  assert.ok(mcpGroup.items.every((item) => item.preselected !== true), "commands are opt-in");

  assert.equal(
    flagEcho({ dest: "setup.tgz", skips: [], plugins: [], hooks: [], mcp: ["ctx7"] }),
    "agent-sync export setup.tgz --mcp ctx7",
  );
});

test("planMcpRegistrations: stdio argv via resolver, fail-closed on missing env, refusals on dirty input", () => {
  const servers = [
    { name: "ctx7", status: "needs_secret", reason: "", transport: "stdio", command: "npx", args: ["-y", "pkg"], envNames: ["CTX7_TOKEN"] },
  ];
  const [registration] = planMcpRegistrations(servers, ["ctx7"], (server, envName) =>
    server === "ctx7" && envName === "CTX7_TOKEN" ? "fresh-value" : undefined,
  );
  assert.deepEqual(registration.args, [
    "mcp", "add", "--transport", "stdio", "--scope", "user", "ctx7",
    "--env", "CTX7_TOKEN=fresh-value", "--", "npx", "-y", "pkg",
  ]);

  assert.throws(
    () => planMcpRegistrations(servers, ["ctx7"], () => undefined),
    /needs CTX7_TOKEN/,
  );
  assert.throws(
    () => planMcpRegistrations([{ ...servers[0], command: "npx\u0000evil" }], ["ctx7"], () => "v"),
    /not a clean string/,
  );
  assert.throws(
    () => planMcpRegistrations([{ ...servers[0], envNames: ["BAD NAME"] }], ["ctx7"], () => "v"),
    /not valid variable names/,
  );
  assert.throws(
    () => planMcpRegistrations([{ ...servers[0], args: Array.from({ length: 65 }, () => "a") }], ["ctx7"], () => "v"),
    /not clean strings/,
  );
});

function cliEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    ...extra,
  };
}

test("static apply: env comes from the target machine's environment, missing env fails closed by name", () => {
  const bundlePath = join(root, "stdio-bundle.tgz");
  execFileSync(process.execPath, ["bin/agent-sync.mjs", "export", bundlePath, "--mcp", "ctx7"], {
    cwd: REPO_ROOT,
    env: { ...cliEnv(fakeHome), CLAUDE_CONFIG_DIR: userDir },
  });

  const applyHome = join(root, "static-apply-home");
  mkdirSync(join(applyHome, ".claude"), { recursive: true });
  const shimDir = join(root, "claude-shim");
  mkdirSync(shimDir, { recursive: true });
  const shimLog = join(shimDir, "log.txt");
  writeFileSync(join(shimDir, "claude"), `#!/bin/sh\necho "$@" >> "${shimLog}"\n`);
  chmodSync(join(shimDir, "claude"), 0o755);

  try {
    execFileSync(
      process.execPath,
      ["bin/agent-sync.mjs", "apply", bundlePath, "--mcp", "ctx7"],
      { cwd: REPO_ROOT, encoding: "utf8", env: cliEnv(applyHome, { PATH: `${shimDir}:${process.env.PATH}` }) },
    );
    assert.fail("expected the missing env to fail closed");
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(String(error.stderr), /needs CTX7_TOKEN/);
    assert.ok(!existsSync(join(applyHome, ".claude", "settings.json")), "fail-closed must precede file writes");
  }

  const output = execFileSync(
    process.execPath,
    ["bin/agent-sync.mjs", "apply", bundlePath, "--mcp", "ctx7"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: cliEnv(applyHome, { PATH: `${shimDir}:${process.env.PATH}`, CTX7_TOKEN: "target-env-value" }),
    },
  );
  assert.match(output, /Registered MCP server ctx7/);
  const logged = readFileSync(shimLog, "utf8");
  assert.match(logged, /--env CTX7_TOKEN=target-env-value -- npx -y @upstash\/context7-mcp/);
  assert.ok(!logged.includes(PLANTED_ENV_VALUE), "the source machine's env value must never appear");
});

function fakeScreenIo() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.resume = () => {};
  input.pause = () => {};
  input.read = () => null;
  input.setRawMode = () => {};
  const chunks = [];
  const output = {
    write: (chunk) => chunks.push(chunk),
    columns: 400,
    rows: 30,
    isTTY: true,
    on: () => {},
    off: () => {},
  };
  return { input, output, chunks };
}

function fakeRoots(claude) {
  return {
    claude,
    codexHome: join(fakeHome, ".codex"),
    codexAgents: join(fakeHome, ".agents"),
    opencodeConfig: join(fakeHome, ".config", "opencode"),
  };
}

test("guided apply: consent shows the command with env placeholders, the typed secret reaches argv but never the screen", async () => {
  const bundlePath = join(root, "stdio-guided.tgz");
  execFileSync(process.execPath, ["bin/agent-sync.mjs", "export", bundlePath, "--mcp", "ctx7"], {
    cwd: REPO_ROOT,
    env: { ...cliEnv(fakeHome), CLAUDE_CONFIG_DIR: userDir },
  });
  const bundle = await loadBundleFromBuffer(readFileSync(bundlePath));
  const target = join(root, "guided-target");
  mkdirSync(target, { recursive: true });
  const registered = [];
  const io = { out: () => {}, err: () => {} };
  const fake = fakeScreenIo();
  const screen = new Screen({ input: fake.input, output: fake.output });

  const running = runGuidedApply(io, "picker", bundle, "stdio-guided.tgz", {
    targetDir: target,
    roots: fakeRoots(target),
    screen,
    env: {},
    register: (registration) => registered.push(registration),
  });
  setImmediate(() => {
    const press = (char, name) => fake.input.emit("keypress", char, { name, sequence: char ?? "\r" });
    press("y", "y");
    press(undefined, "return"); // consent to ctx7 (stdio)
    press(undefined, "return"); // decline linear (remote), default no
    for (const character of "s3cret-typed-fresh") press(character, character);
    press(undefined, "return"); // submit the secret
  });
  assert.equal(await running, 0);

  assert.equal(registered.length, 1);
  assert.ok(registered[0].args.includes("CTX7_TOKEN=s3cret-typed-fresh"));

  const rendered = fake.chunks.join("");
  assert.match(rendered, /mcp server ctx7 wants to register on this machine/);
  assert.match(rendered, /command: npx -y @upstash\/context7-mcp/);
  assert.match(rendered, /env \(values asked next, never carried\): CTX7_TOKEN/);
  assert.match(rendered, /Register MCP server ctx7\?/);
  assert.match(rendered, /ctx7 needs CTX7_TOKEN/);
  assert.match(rendered, /\*{6,}/, "the masked prompt shows asterisks");
  assert.ok(!rendered.includes("s3cret-typed-fresh"), "the typed secret leaked to the screen");
  assert.ok(!rendered.includes(PLANTED_ENV_VALUE));
});

test("flow.secret: masks input, backspace works, esc cancels", async () => {
  const fake = fakeScreenIo();
  const screen = new Screen({ input: fake.input, output: fake.output });
  const flow = createFlow(screen, createTheme({ env: { TERM: "linux" }, platform: "linux", isTTY: false }));
  flow.intro("t");
  const pending = flow.secret("token?");
  const press = (char, name) => fake.input.emit("keypress", char, { name, sequence: char ?? "\r" });
  for (const character of "abcd") press(character, character);
  press(undefined, "backspace");
  press(undefined, "return");
  assert.deepEqual(await pending, { cancelled: false, value: "abc" });
  assert.ok(!fake.chunks.join("").includes("abc"), "plaintext leaked from the masked prompt");
  screen.close();

  const second = fakeScreenIo();
  const screen2 = new Screen({ input: second.input, output: second.output });
  const flow2 = createFlow(screen2, createTheme({ env: { TERM: "linux" }, platform: "linux", isTTY: false }));
  flow2.intro("t");
  const cancelledPending = flow2.secret("token?");
  second.input.emit("keypress", undefined, { name: "escape", sequence: "\u001b" });
  assert.deepEqual(await cancelledPending, { cancelled: true });
  screen2.close();
});

test("round 1: dry-run plans with placeholders and never echoes a real value", () => {
  const bundlePath = join(root, "stdio-dry.tgz");
  execFileSync(process.execPath, ["bin/agent-sync.mjs", "export", bundlePath, "--mcp", "ctx7"], {
    cwd: REPO_ROOT,
    env: { ...cliEnv(fakeHome), CLAUDE_CONFIG_DIR: userDir },
  });
  const home = join(root, "dry-home");
  mkdirSync(join(home, ".claude"), { recursive: true });

  const withEnv = execFileSync(
    process.execPath,
    ["bin/agent-sync.mjs", "apply", bundlePath, "--mcp", "ctx7", "--dry-run"],
    { cwd: REPO_ROOT, encoding: "utf8", env: cliEnv(home, { CTX7_TOKEN: "real-secret-value-555" }) },
  );
  assert.match(withEnv, /--env CTX7_TOKEN=\.\.\. -- npx/);
  assert.ok(!withEnv.includes("real-secret-value-555"), "dry-run echoed a resolved secret");

  const withoutEnv = execFileSync(
    process.execPath,
    ["bin/agent-sync.mjs", "apply", bundlePath, "--mcp", "ctx7", "--dry-run"],
    { cwd: REPO_ROOT, encoding: "utf8", env: cliEnv(home) },
  );
  assert.match(withoutEnv, /Would register MCP server ctx7/, "dry-run must not require env values");
});

test("round 1: CR, LF and TAB are rejected as dirty strings", () => {
  const base = { name: "x", status: "needs_secret", reason: "", transport: "stdio", command: "npx", envNames: [] };
  for (const dirty of ["a\nb", "a\rb", "a\tb"]) {
    assert.throws(
      () => planMcpRegistrations([{ ...base, args: [dirty] }], ["x"], () => "v"),
      /not clean strings/,
      JSON.stringify(dirty),
    );
  }
});

test("round 1: the stdio branch re-runs the portability gate over the untrusted manifest", () => {
  const base = { name: "x", status: "needs_secret", reason: "", transport: "stdio", envNames: [] };
  const cases = [
    { ...base, command: "/Users/attacker/payload.sh", args: [] },
    { ...base, command: "npx", args: ["scripts/serve.py"] },
    { ...base, command: "serve.py", args: [] },
    { ...base, command: "npx", args: ["http://10.0.0.1/steal"] },
    { ...base, command: "npx", args: ["http://127.1/loop"] },
    { ...base, command: "ruby", args: ["tool.rb"] },
  ];
  for (const server of cases) {
    assert.throws(
      () => planMcpRegistrations([server], ["x"], () => "v"),
      /portability gate|not a clean string/,
      JSON.stringify(server),
    );
  }
  assert.throws(
    () => planMcpRegistrations([{ ...base, command: "npx", args: ["--token", `${"ghp"}_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`] }], ["x"], () => "v"),
    /portability gate/,
    "a token-shaped arg is a value and values never travel",
  );
});

test("round 1: a hostile manifest cannot reach the guided consent frame", async () => {
  const { createHash } = await import("node:crypto");
  const dir = join(root, "hostile-consent");
  mkdirSync(join(dir, "files"), { recursive: true });
  const settings = Buffer.from(JSON.stringify({ model: "opus" }));
  const manifest = {
    schemaVersion: 1,
    tool: "agent-sync",
    agent: "claude-code",
    files: [{ path: "settings.json", sha256: createHash("sha256").update(settings).digest("hex"), size: settings.length }],
    mcpServers: [
      {
        name: "evil",
        status: "needs_secret",
        reason: "",
        transport: "stdio",
        command: "npx",
        args: ["ok\r\nFORGED-CONSENT-LINE: totally safe, press y"],
        envNames: [],
      },
    ],
    hooks: [],
  };
  writeFileSync(join(dir, "files", "settings.json"), settings);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const { loadBundleFromDirectory } = await import("../dist/main.js");
  const bundle = loadBundleFromDirectory(dir);

  const target = join(root, "hostile-consent-target");
  mkdirSync(target, { recursive: true });
  const io = { out: () => {}, err: () => {} };
  const fake = fakeScreenIo();
  const screen = new Screen({ input: fake.input, output: fake.output });
  let failure = null;
  try {
    await runGuidedApply(io, "picker", bundle, "evil.tgz", {
      targetDir: target,
      roots: fakeRoots(target),
      screen,
      env: {},
      register: () => {},
    });
    assert.fail("hostile stdio entry must refuse");
  } catch (error) {
    failure = error;
  }
  assert.match(String(failure), /not clean strings/);
  assert.ok(!fake.chunks.join("").includes("FORGED-CONSENT-LINE"), "the forged text reached a frame");
  assert.ok(!existsSync(join(target, "settings.json")), "nothing may be written");
});

test("round 1: wrapDisplay loses no characters and maskRegistrationDisplay hides values", async () => {
  const { wrapDisplay, maskRegistrationDisplay } = await import("../dist/main.js");
  const long = `  command: npx ${"x".repeat(300)}end`;
  const wrapped = wrapDisplay(long, 76);
  assert.ok(wrapped.length > 3);
  assert.equal(wrapped.map((line, i) => (i === 0 ? line : line.slice(4))).join(""), long, "wrap must preserve every character");
  assert.ok(wrapped.join("").includes("end"));

  const registration = { name: "x", args: ["mcp", "add", "--env", "TOKEN=sup3r-s3cret", "--", "npx"] };
  const masked = maskRegistrationDisplay("claude mcp add --env TOKEN=sup3r-s3cret -- npx (sup3r-s3cret)", registration);
  assert.ok(!masked.includes("sup3r-s3cret"));
  assert.match(masked, /TOKEN=\.\.\./);
});


test("round 2: the consent wrap survives an 80-column terminal with zero hidden characters", async () => {
  const bundleDir = join(root, "narrow-consent");
  mkdirSync(join(bundleDir, "files"), { recursive: true });
  const { createHash } = await import("node:crypto");
  const settings = Buffer.from(JSON.stringify({ model: "opus" }));
  const longArg = `${"a".repeat(200)}ZZENDMARKZZ`;
  const manifest = {
    schemaVersion: 1,
    tool: "agent-sync",
    agent: "claude-code",
    files: [{ path: "settings.json", sha256: createHash("sha256").update(settings).digest("hex"), size: settings.length }],
    mcpServers: [
      { name: "longone", status: "needs_secret", reason: "", transport: "stdio", command: "npx", args: ["-y", longArg], envNames: [] },
    ],
    hooks: [],
  };
  writeFileSync(join(bundleDir, "files", "settings.json"), settings);
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
  const { loadBundleFromDirectory } = await import("../dist/main.js");
  const bundle = loadBundleFromDirectory(bundleDir);

  const target = join(root, "narrow-consent-target");
  mkdirSync(target, { recursive: true });
  const io = { out: () => {}, err: () => {} };
  const fake = fakeScreenIo();
  fake.output.columns = 80;
  const screen = new Screen({ input: fake.input, output: fake.output });

  const running = runGuidedApply(io, "picker", bundle, "n.tgz", {
    targetDir: target,
    roots: fakeRoots(target),
    screen,
    env: {},
    register: () => {},
  });
  setImmediate(() => {
    fake.input.emit("keypress", undefined, { name: "return", sequence: "\r" }); // decline the consent, default no
  });
  assert.equal(await running, 0);
  const rendered = fake.chunks.join("");
  assert.ok(rendered.includes("ZZENDMARKZZ"), "the tail of a wrapped consent line was hidden at 80 columns");
});

test("round 2: an unvalidated hostile name never reaches stderr unsanitized, and C1/bidi controls refuse", () => {
  const hostileName = "\u001b[2Jevil";
  const base = { name: hostileName, status: "needs_secret", reason: "", transport: "stdio", command: "npx", args: [], envNames: [] };
  let failure = null;
  try {
    planMcpRegistrations([base], [hostileName], () => "v");
  } catch (error) {
    failure = String(error);
  }
  assert.ok(failure !== null);
  assert.ok(!failure.includes("\u001b"), "raw ESC survived into the error message");
  assert.ok(failure.includes("\ufffd"));

  const clean = { name: "x", status: "needs_secret", reason: "", transport: "stdio", command: "npx", envNames: [] };
  for (const dirty of ["a\u009bb", "a\u202eb", "a\u200bb", "a\u2066b", "a\ufeffb"]) {
    assert.throws(
      () => planMcpRegistrations([{ ...clean, args: [dirty] }], ["x"], () => "v"),
      /not clean strings/,
      JSON.stringify(dirty),
    );
  }
});


test("round 3: wide characters cannot resurrect the consent elision, and Cf invisibles refuse", async () => {
  const { wrapDisplay } = await import("../dist/main.js");
  const wide = "\u5b57".repeat(120) + "WIDETAILMARK";
  const wrapped = wrapDisplay(`  command: npx ${wide}`, 72);
  assert.ok(wrapped.join("").includes("WIDETAILMARK"), "the wide tail fell off the wrap");
  for (const line of wrapped) {
    const content = line.startsWith("    ") ? line.slice(4) : line;
    let cells = 0;
    for (const ch of content) cells += /[\u1100-\u9fff]/.test(ch) ? 2 : 1;
    assert.ok(cells <= 72, `a wrapped line overflows the cell budget: ${cells}`);
  }

  const clean = { name: "x", status: "needs_secret", reason: "", transport: "stdio", command: "npx", envNames: [] };
  for (const dirty of ["a\u061cb", "a\u2060b", "a\u00adb"]) {
    assert.throws(
      () => planMcpRegistrations([{ ...clean, args: [dirty] }], ["x"], () => "v"),
      /not clean strings/,
      JSON.stringify(dirty),
    );
  }
});
