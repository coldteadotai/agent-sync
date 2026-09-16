import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  applyFlagEcho,
  collectExport,
  loadBundleFromBuffer,
  Plain,
  runGuided,
  runGuidedApply,
  scanContentForSecrets,
  Screen,
} from "../dist/main.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Assembled at runtime so this file never contains a token-shaped literal.
const FAKE_OPENAI = ["sk", "-"].join("") + "Abcdefghijklmnopqrstuv0123456789";
const FAKE_GITHUB = ["ghp", "_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const FAKE_SLACK = ["xoxb", "-"].join("") + "123456789012-abcdefghijklmnop";
const FAKE_AWS = ["AK", "IA"].join("") + "IOSFODNN7EXAMPLE";

let root;
let userDir;

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-applyflow-"));
  userDir = join(root, ".claude");
  mkdirSync(join(userDir, "skills", "clean"), { recursive: true });
  writeFileSync(join(userDir, "skills", "clean", "SKILL.md"), "# clean\nnothing secret here\n");
  writeFileSync(
    join(userDir, "settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "prettier --write ." }] }] },
      enabledPlugins: { "ponytail@market": true },
      extraKnownMarketplaces: { market: { source: { source: "github", repo: "acme/market" } } },
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

test("secret patterns match planted tokens and skip hashes, prose and binaries", () => {
  const positive = (text, kind) => {
    const findings = scanContentForSecrets(Buffer.from(`line one\n${text}\n`));
    assert.equal(findings.length, 1, `${kind} not found`);
    assert.equal(findings[0].line, 2);
    assert.equal(findings[0].kind, kind);
  };
  positive(`key = ${FAKE_OPENAI}`, "API key");
  positive(`token: ${FAKE_GITHUB}`, "GitHub token");
  positive(`slack ${FAKE_SLACK}`, "Slack token");
  positive(`aws ${FAKE_AWS}`, "AWS access key");
  positive("-----BEGIN RSA PRIVATE KEY-----", "private key");
  positive(`jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0`, "JWT");

  assert.deepEqual(scanContentForSecrets(Buffer.from("plain prose about exporting skills\n")), []);
  assert.deepEqual(
    scanContentForSecrets(Buffer.from("sha256: 9b74c9897bac770ffc029102a200c5de1a11b6e9e6a86b1d1c8d0b1f2c3d4e5f\n")),
    [],
    "hex digests must not trip the entropy detector",
  );
  assert.deepEqual(
    scanContentForSecrets(Buffer.from("thisIsAVeryLongCamelCaseIdentifierUsedInTheCodebaseEverywhere\n")),
    [],
    "long identifiers must not trip the entropy detector",
  );
  assert.deepEqual(scanContentForSecrets(Buffer.concat([Buffer.from("a"), Buffer.from([0]), Buffer.from("b")])), []);

  const npmLock = '    "integrity": "sha512-C3TGLGfBTGVv0uKnwm7hM1TeQzHzHJcPmnR6wIYWrlBUv0Q+YvJPGvjLBP7bnTL5oRVDCafUOOXHDrGe0DsQjA=="\n';
  const yarnLock = "  integrity sha512-C3TGLGfBTGVv0uKnwm7hM1TeQzHzHJcPmnR6wIYWrlBUv0Q+YvJPGvjLBP7bnTL5oRVDCafUOOXHDrGe0DsQjA==\n";
  const sri384 = 'crossorigin integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"\n';
  assert.deepEqual(scanContentForSecrets(Buffer.from(npmLock)), [], "npm lockfile integrity must not trip");
  assert.deepEqual(scanContentForSecrets(Buffer.from(yarnLock)), [], "yarn lockfile integrity must not trip");
  assert.deepEqual(scanContentForSecrets(Buffer.from(sri384)), [], "SRI attribute must not trip");
});

test("a planted token refuses the file by default and never appears in any output", () => {
  const secretDir = mkdtempSync(join(tmpdir(), "agent-sync-secret-"));
  try {
    const secretUser = join(secretDir, ".claude");
    mkdirSync(join(secretUser, "skills", "leaky"), { recursive: true });
    writeFileSync(join(secretUser, "skills", "leaky", "SKILL.md"), `# leaky\napi key: ${FAKE_OPENAI}\n`);
    const options = { userDir: secretUser, claudeJsonPath: join(secretUser, ".claude.json") };

    const refused = collectExport(options);
    assert.ok(!refused.entries.some((entry) => entry.path.includes("leaky")));
    const skip = refused.skipped.find((entry) => entry.path === "skills/leaky/SKILL.md");
    assert.match(skip.reason, /API key pattern \(line 2\)/);
    assert.deepEqual(refused.secretFindings, [{ path: "skills/leaky/SKILL.md", line: 2, kind: "API key" }]);
    const everything = JSON.stringify(refused.manifest) + JSON.stringify(refused.skipped) + JSON.stringify(refused.diagnostics);
    assert.ok(!everything.includes(FAKE_OPENAI), "the matched value leaked into a diagnostic");

    const carried = collectExport({ ...options, allowSecrets: ["skills/leaky/SKILL.md"] });
    assert.ok(carried.entries.some((entry) => entry.path === "skills/leaky/SKILL.md"));
    assert.ok(carried.diagnostics.every((d) => d.severity !== "error"));

    const unknown = collectExport({ ...options, allowSecrets: ["skills/clean/SKILL.md"] });
    assert.ok(unknown.diagnostics.some((d) => d.severity === "error"));
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
});

test("guided export asks consent per flagged file, default no", async () => {
  const secretDir = mkdtempSync(join(tmpdir(), "agent-sync-secretflow-"));
  try {
    const secretUser = join(secretDir, ".claude");
    mkdirSync(join(secretUser, "skills", "leaky"), { recursive: true });
    writeFileSync(join(secretUser, "skills", "leaky", "SKILL.md"), `token ${FAKE_GITHUB}\n`);
    const destDir = join(secretDir, "out");
    mkdirSync(destDir, { recursive: true });

    const said = [];
    const plain = new Plain({
      // travel defaults, destination 1, secret consent yes, write yes
      input: Readable.from(["\n1\ny\ny\n"]),
      output: { write: (chunk) => said.push(chunk) },
    });
    const io = { out: () => {}, err: () => {} };
    const code = await runGuided(io, "plain", {
      userDir: secretUser,
      claudeJsonPath: join(secretUser, ".claude.json"),
      destDir,
      plain,
    });
    assert.equal(code, 0);
    const transcript = said.join("");
    assert.match(transcript, /looks like it contains a secret \(line 1, GitHub token\)/);
    assert.ok(!transcript.includes(FAKE_GITHUB), "prompt leaked the matched value");
    assert.match(transcript, /--allow-secret skills\/leaky\/SKILL\.md/);
    const bundle = await loadBundleFromBuffer(readFileSync(join(destDir, "setup.tgz")));
    assert.ok(bundle.files.has("skills/leaky/SKILL.md"));
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
});

function exportBundle(name) {
  const dest = join(root, name);
  execFileSync(
    process.execPath,
    ["bin/agent-sync.mjs", "export", dest, "--hook", "hooks.PostToolUse", "--plugin", "ponytail@market"],
    { cwd: REPO_ROOT, env: { ...process.env, CLAUDE_CONFIG_DIR: userDir } },
  );
  return dest;
}

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

test("guided apply: consent decides hook yes, plugin no, mcp yes — writes run the flag path", async () => {
  const bundlePath = exportBundle("flow-bundle.tgz");
  const bundle = await loadBundleFromBuffer(readFileSync(bundlePath));
  const target = join(root, "flow-target");
  mkdirSync(target, { recursive: true });
  const registered = [];
  const io = { out: () => {}, err: () => {} };
  const fake = fakeScreenIo();
  const screen = new Screen({ input: fake.input, output: fake.output });

  const running = runGuidedApply(io, "picker", bundle, "flow-bundle.tgz", {
    targetDir: target,
    explicitTarget: true,
    screen,
    env: {},
    register: (registration) => registered.push(registration),
  });
  setImmediate(() => {
    const press = (char, name) => fake.input.emit("keypress", char, { name, sequence: char ?? "\r" });
    press("y", "y");
    press(undefined, "return"); // hook: yes
    press(undefined, "return"); // plugin: default no
    press("y", "y");
    press(undefined, "return"); // mcp: yes
  });
  assert.equal(await running, 0);

  const applied = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(applied.hooks), ["PostToolUse"]);
  assert.ok(!("enabledPlugins" in applied), "unconsented plugin survived the flow");
  assert.ok(!("extraKnownMarketplaces" in applied));
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].args.slice(0, 2), ["mcp", "add"]);
  assert.ok(existsSync(join(target, ".agent-sync", "last-applied.json")));

  const rendered = fake.chunks.join("");
  assert.match(rendered, /Bundle verified/);
  assert.match(rendered, /nothing written yet/);
  assert.match(rendered, /claude mcp add --transport http --scope user linear/);
  assert.match(rendered, /agent-sync undo puts it all back/);
  assert.match(rendered, /agent-sync apply flow-bundle\.tgz --target .* --hook hooks\.PostToolUse --mcp linear/);
});

test("guided apply in plain mode over piped stdin", async () => {
  const bundlePath = exportBundle("plain-flow-bundle.tgz");
  const bundle = await loadBundleFromBuffer(readFileSync(bundlePath));
  const target = join(root, "plain-flow-target");
  mkdirSync(target, { recursive: true });
  const said = [];
  const plain = new Plain({
    input: Readable.from(["n\nn\nn\n"]),
    output: { write: (chunk) => said.push(chunk) },
  });
  const io = { out: () => {}, err: () => {} };

  const code = await runGuidedApply(io, "plain", bundle, "plain-flow-bundle.tgz", {
    targetDir: target,
    plain,
  });
  assert.equal(code, 0);
  const applied = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
  assert.deepEqual(applied, { model: "opus" }, "every consent was declined, only preferences apply");
  assert.match(said.join(""), /Run hooks\.PostToolUse on this machine\? \(prettier --write \.\)/);
});

test("guided apply cancel writes nothing", async () => {
  const bundlePath = exportBundle("cancel-flow-bundle.tgz");
  const bundle = await loadBundleFromBuffer(readFileSync(bundlePath));
  const target = join(root, "cancel-flow-target");
  mkdirSync(target, { recursive: true });
  const io = { out: () => {}, err: () => {} };
  const fake = fakeScreenIo();
  const screen = new Screen({ input: fake.input, output: fake.output });

  const running = runGuidedApply(io, "picker", bundle, "b.tgz", { targetDir: target, screen, env: {} });
  setImmediate(() => {
    fake.input.emit("keypress", undefined, { name: "c", ctrl: true, sequence: "\x03" });
  });
  assert.equal(await running, 2);
  assert.ok(!existsSync(join(target, "settings.json")));
  assert.ok(!existsSync(join(target, ".agent-sync")));
});

test("apply flag echo spells the scripted equivalent", () => {
  assert.equal(
    applyFlagEcho({ source: "setup.tgz", hooks: ["hooks.Stop"], plugins: ["p@m"], mcp: ["linear"] }),
    "agent-sync apply setup.tgz --hook hooks.Stop --plugin p@m --mcp linear",
  );
  assert.equal(
    applyFlagEcho({ source: "b.tgz", target: "/x/y", hooks: [], plugins: [], mcp: [] }),
    "agent-sync apply b.tgz --target /x/y",
  );
});

test("apply from stdin stays static even with --plain: stdin IS the bundle", () => {
  const bundlePath = exportBundle("stdin-bundle.tgz");
  const target = join(root, "stdin-target");
  mkdirSync(target, { recursive: true });
  const output = execFileSync(
    process.execPath,
    ["bin/agent-sync.mjs", "apply", "-", "--plain", "--target", target],
    { cwd: REPO_ROOT, encoding: "utf8", input: readFileSync(bundlePath) },
  );
  assert.match(output, /Withheld hooks\.PostToolUse/, "the static consent surface must run");
  assert.match(output, /Done: /);
  const applied = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
  assert.ok(!("hooks" in applied), "an unconsented hook applied from a stdin bundle");
});

test("piped apply keeps the static surface", () => {
  const bundlePath = exportBundle("static-bundle.tgz");
  const target = join(root, "static-target");
  mkdirSync(target, { recursive: true });
  const output = execFileSync(
    process.execPath,
    ["bin/agent-sync.mjs", "apply", bundlePath, "--target", target],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.match(output, /Withheld hooks\.PostToolUse/);
  assert.match(output, /Withheld plugin ponytail@market/);
  assert.match(output, /Done: /);
});
