import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMcpServer, collectExport, planMcpRegistrations, sanitizeRemoteEndpoint } from "../dist/main.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO_ROOT, "bin", "agent-sync.mjs");

let root;
let sourceDir;
let shimDir;
let shimLog;
let bundleTar;

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: sourceDir,
      PATH: `${shimDir}:${process.env.PATH}`,
      CLAUDE_SHIM_LOG: shimLog,
    },
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-sync-mcp-"));
  sourceDir = join(root, ".claude");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "CLAUDE.md"), "memory\n");
  writeFileSync(
    join(sourceDir, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        events: { type: "sse", url: "https://mcp.events.example.com/stream" },
        localtool: { command: "node", args: ["./tool.js"] },
      },
    }),
  );

  shimDir = join(root, "shim-bin");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "claude"), `#!/bin/sh\necho "$@" >> "$CLAUDE_SHIM_LOG"\n`, { mode: 0o755 });
  shimLog = join(root, "claude-shim.log");

  bundleTar = join(root, "bundle.tar");
  runCli(["export", bundleTar]);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("classification exposes only clean urls", () => {
  assert.equal(classifyMcpServer({ type: "http", url: "https://x.example.com/mcp" }).url, "https://x.example.com/mcp");
  assert.equal(classifyMcpServer({ type: "sse", url: "https://x.example.com/s" }).transport, "sse");

  const userinfo = classifyMcpServer({ url: "https://user:sekret@x.example.com/mcp" });
  assert.equal(userinfo.status, "needs_secret");
  assert.equal(userinfo.url, undefined);
  assert.ok(!JSON.stringify(userinfo).includes("sekret"));

  const query = classifyMcpServer({ url: "https://x.example.com/mcp?api_key=sekret" });
  assert.equal(query.status, "needs_secret");
  assert.equal(query.url, undefined);
  assert.ok(!JSON.stringify(query).includes("sekret"));
});

test("manifest carries urls for portable servers only", () => {
  const plan = collectExport({ userDir: sourceDir, claudeJsonPath: join(sourceDir, ".claude.json") });
  const byName = new Map(plan.manifest.mcpServers.map((server) => [server.name, server]));
  assert.equal(byName.get("linear").url, "https://mcp.linear.app/mcp");
  assert.equal(byName.get("events").transport, "sse");
  assert.equal(byName.get("localtool").url, undefined);
});

test("apply --mcp registers through claude mcp add with name and url only", () => {
  const target = join(root, "target-register");
  mkdirSync(target, { recursive: true });
  const output = runCli(["apply", bundleTar, "--target", target, "--mcp", "linear", "--mcp", "events"]);
  assert.match(output, /Registered MCP server linear/);
  const log = readFileSync(shimLog, "utf8").trim().split("\n");
  assert.deepEqual(log, [
    "mcp add --transport http --scope user linear https://mcp.linear.app/mcp",
    "mcp add --transport sse --scope user events https://mcp.events.example.com/stream",
  ]);
});

test("dry-run prints the registration and never invokes claude", () => {
  rmSync(shimLog, { force: true });
  const target = join(root, "target-dry");
  mkdirSync(target, { recursive: true });
  const output = runCli(["apply", bundleTar, "--target", target, "--mcp", "linear", "--dry-run"]);
  assert.match(output, /Would register MCP server linear: claude mcp add/);
  assert.ok(!existsSync(shimLog));
});

test("a bad --mcp refuses the whole apply before any write", () => {
  for (const [flag, pattern] of [
    ["nope", /does not match any server/],
    ["localtool", /not portable/],
  ]) {
    const target = join(root, `target-bad-${flag}`);
    mkdirSync(target, { recursive: true });
    assert.throws(() => runCli(["apply", bundleTar, "--target", target, "--mcp", flag]), pattern);
    assert.ok(!existsSync(join(target, "CLAUDE.md")), `files must not land for --mcp ${flag}`);
  }
});

test("a hostile manifest cannot smuggle secrets or flags into the argv", () => {
  const hostile = (overrides) =>
    planMcpRegistrations(
      [{ name: "srv", status: "candidate", reason: "r", url: "https://x.example.com/", ...overrides }],
      ["srv"],
    );
  assert.throws(() => hostile({ url: "https://user:pass@x.example.com/" }), /embeds credentials/);
  assert.throws(() => hostile({ url: "https://x.example.com/?token=abc" }), /query or fragment/);
  assert.throws(() => hostile({ url: "file:///etc/passwd" }), /not http/);
  assert.throws(
    () =>
      planMcpRegistrations(
        [{ name: "-rf", status: "candidate", reason: "r", url: "https://x.example.com/" }],
        ["-rf"],
      ),
    /not safe to pass along/,
  );
});

test("unregistered portable servers are named as a hint", () => {
  const target = join(root, "target-hint");
  mkdirSync(target, { recursive: true });
  const output = runCli(["apply", bundleTar, "--target", target]);
  assert.match(output, /pass --mcp <name> to register: events, linear/);
});

test("local and private addresses never become re-declarable endpoints", () => {
  for (const url of [
    "http://localhost:9000/mcp",
    "http://127.0.0.1:9000/mcp",
    "http://[::1]:9000/mcp",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.5/mcp",
    "http://192.168.1.10/mcp",
    "http://172.16.0.1/mcp",
    "http://172.31.255.255/mcp",
    "http://[fe80::1]/mcp",
    "http://[fd12:3456::1]/mcp",
  ]) {
    const check = sanitizeRemoteEndpoint(url);
    assert.equal(check.ok, false, url);
    assert.match(check.reason, /local or private/, url);
  }
  assert.equal(sanitizeRemoteEndpoint("http://172.32.0.1/mcp").ok, true, "public range stays allowed");
});

test("ipv4-mapped ipv6 loopback is refused and ipv6-looking domains are not", () => {
  for (const url of [
    "http://[::ffff:127.0.0.1]/mcp",
    "http://[::ffff:7f00:1]/mcp",
    "http://[::ffff:10.0.0.1]/mcp",
    "http://[::ffff:a9fe:a9fe]/mcp",
  ]) {
    const check = sanitizeRemoteEndpoint(url);
    assert.equal(check.ok, false, url);
    assert.match(check.reason, /local or private/, url);
  }
  for (const url of [
    "https://fd.io/mcp",
    "https://fcc.gov/mcp",
    "https://fdroid.example.com/mcp",
    "https://fe80site.example.com/mcp",
  ]) {
    assert.equal(sanitizeRemoteEndpoint(url).ok, true, url);
  }
  assert.equal(sanitizeRemoteEndpoint("http://[::ffff:808:808]/mcp").ok, true, "mapped public v4 stays allowed");
  assert.equal(sanitizeRemoteEndpoint("http://[::127.0.0.1]/mcp").ok, false, "deprecated compatible loopback refused");
  assert.equal(sanitizeRemoteEndpoint("http://[::7f00:1]/mcp").ok, false, "canonicalized compatible loopback refused");
  assert.equal(sanitizeRemoteEndpoint("http://[::808:808]/mcp").ok, true, "compatible public v4 stays allowed");
  assert.equal(sanitizeRemoteEndpoint("http://[2001:db8::1]/mcp").ok, true, "ordinary public v6 stays allowed");
});

test("a crafted candidate manifest entry with a local url refuses registration", () => {
  for (const url of ["http://localhost:9000/mcp", "http://169.254.169.254/latest", "http://10.1.2.3/mcp"]) {
    assert.throws(
      () =>
        planMcpRegistrations([{ name: "srv", status: "candidate", reason: "r", url }], ["srv"]),
      /local or private/,
      url,
    );
  }
});

test("a clean url pointing at private space classifies without carrying the url", () => {
  const metadata = classifyMcpServer({ type: "http", url: "http://169.254.169.254/latest" });
  assert.equal(metadata.url, undefined);
  assert.equal(metadata.status, "needs_secret");
  const lan = classifyMcpServer({ type: "http", url: "http://192.168.1.50/mcp" });
  assert.equal(lan.url, undefined);
});

test("one failed registration does not stop the rest and exits 2", () => {
  const failShimDir = join(root, "fail-shim-bin");
  mkdirSync(failShimDir, { recursive: true });
  writeFileSync(
    join(failShimDir, "claude"),
    `#!/bin/sh\ncase "$@" in *events*) echo "boom: events unreachable" >&2; exit 1;; *) echo "$@" >> "$CLAUDE_SHIM_LOG";; esac\n`,
    { mode: 0o755 },
  );
  const failLog = join(root, "fail-shim.log");
  const target = join(root, "target-partial-fail");
  mkdirSync(target, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [BIN, "apply", bundleTar, "--target", target, "--mcp", "events", "--mcp", "linear"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: sourceDir, PATH: `${failShimDir}:${process.env.PATH}`, CLAUDE_SHIM_LOG: failLog },
      },
    );
    assert.fail("expected exit 2");
  } catch (error) {
    assert.equal(error.status, 2);
    const stderr = error.stderr.toString("utf8");
    assert.match(stderr, /events.*failed|failed.*events/s);
    assert.match(stderr, /1 MCP registration\(s\) failed; files were applied/);
    const stdout = error.stdout.toString("utf8");
    assert.match(stdout, /Registered MCP server linear/);
    assert.match(readFileSync(failLog, "utf8"), /linear/);
  }
});

test("sanitizeRemoteEndpoint accepts plain endpoints and normalizes nothing away", () => {
  assert.deepEqual(sanitizeRemoteEndpoint("https://x.example.com/mcp"), {
    ok: true,
    url: "https://x.example.com/mcp",
  });
  assert.equal(sanitizeRemoteEndpoint("not a url").ok, false);
});
