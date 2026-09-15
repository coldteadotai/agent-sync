import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml } from "../dist/main.js";

test("tables, dotted keys, scalars and comments parse", () => {
  const parsed = parseToml([
    "# top comment",
    'model = "o3" # trailing comment',
    "model_reasoning_effort = \"high\"",
    "retries = 3",
    "ratio = 0.5",
    "enabled = true",
    "",
    "[mcp_servers.linear]",
    'url = "https://mcp.linear.app/mcp"',
    "",
    "[mcp_servers.local]",
    'command = "npx"',
    'args = ["-y", "some-pkg"]',
    'env = { API_TOKEN = "$API_TOKEN" }',
  ].join("\n"));
  assert.equal(parsed.model, "o3");
  assert.equal(parsed.retries, 3);
  assert.equal(parsed.ratio, 0.5);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.mcp_servers.linear.url, "https://mcp.linear.app/mcp");
  assert.deepEqual(parsed.mcp_servers.local.args, ["-y", "some-pkg"]);
  assert.equal(parsed.mcp_servers.local.env.API_TOKEN, "$API_TOKEN");
});

test("multiline arrays and escapes parse", () => {
  const parsed = parseToml(['args = [', '  "-y", # comment inside', '  "pkg\\"quoted\\"",', ']', 'note = "line\\nbreak \\u0041"'].join("\n"));
  assert.deepEqual(parsed.args, ["-y", 'pkg"quoted"']);
  assert.equal(parsed.note, "line\nbreak A");
});

test("hash inside strings is not a comment and equals inside strings is not a separator", () => {
  const parsed = parseToml('url = "https://x.example.com/#frag"\ntitle = "a = b"');
  assert.equal(parsed.url, "https://x.example.com/#frag");
  assert.equal(parsed.title, "a = b");
});

test("unsupported constructs are refused loudly, never misparsed", () => {
  assert.throws(() => parseToml('s = """multi"""'), /multiline strings/);
  assert.throws(() => parseToml("[[array_of_tables]]"), /unsupported table header/);
  assert.throws(() => parseToml("date = 2026-09-15"), /unsupported value/);
  assert.throws(() => parseToml("broken"), /expected key = value/);
  assert.throws(() => parseToml('a = "unterminated'), /unterminated/);
  assert.throws(() => parseToml('a = 1\na = 2'), /duplicate key/);
  try {
    parseToml('a = 1\na = "second-sekret-value"');
    assert.fail("expected duplicate-key throw");
  } catch (error) {
    assert.ok(!error.message.includes("sekret"));
  }
});

test("duplicate table headers are an error, not a silent merge", () => {
  assert.throws(() => parseToml("[a]\nx = 1\n[a]\ny = 2"), /duplicate table header/);
  assert.throws(
    () => parseToml('[mcp_servers.foo]\nurl = "https://x.example.com"\n[mcp_servers.foo]\ncommand = "npx"'),
    /duplicate table header/,
  );
  const siblings = parseToml("[a.b]\nx = 1\n[a.c]\ny = 2");
  assert.deepEqual(siblings, { a: { b: { x: 1 }, c: { y: 2 } } });
});

test("strings never span physical lines and escape errors carry no content", () => {
  assert.throws(() => parseToml('k = ["a\n# would be stripped\nZ"]'), /unterminated string/);
  try {
    parseToml('k = "a\\qSEKRET"');
    assert.fail("expected escape error");
  } catch (error) {
    assert.match(error.message, /unsupported escape sequence/);
    assert.ok(!error.message.includes("SEKRET"));
    assert.ok(!error.message.includes("\\q"));
  }
});

test("prototype pollution keys are refused", () => {
  assert.throws(() => parseToml('__proto__ = { polluted = true }'), /refusing key/);
  assert.throws(() => parseToml("[constructor.prototype]\nx = 1"), /refusing key/);
  assert.equal({}.polluted, undefined);
});

test("parse errors carry line numbers, not file content", () => {
  try {
    parseToml('ok = "fine"\nsecret_line = @sekret-value');
    assert.fail("expected throw");
  } catch (error) {
    assert.match(error.message, /line 2/);
    assert.ok(!error.message.includes("sekret-value"));
  }
});
