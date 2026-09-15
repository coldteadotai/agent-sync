import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMcpServer, isSensitiveKey, scanSecretReferences } from "../dist/main.js";

test("remote server with env refs is needs_secret and leaks no values", () => {
  const classification = classifyMcpServer({
    url: "https://mcp.example.com/sse",
    headers: { Authorization: "Bearer should-not-appear" },
    env: { MCP_API_TOKEN: "should-not-appear" },
  });
  assert.equal(classification.status, "needs_secret");
  assert.deepEqual(classification.envRefs, ["MCP_API_TOKEN"]);
  assert.ok(!classification.reason.includes("should-not-appear"));
});

test("stdio server with a machine-local path is blocked", () => {
  const classification = classifyMcpServer({
    command: "node",
    args: ["/Users/alice/mcp/server.js"],
    env: { LOCAL_TOKEN: "$LOCAL_TOKEN" },
  });
  assert.equal(classification.status, "blocked");
  assert.deepEqual(classification.envRefs, ["LOCAL_TOKEN"]);
});

test("secret-shaped values are never emitted as env refs", () => {
  const classification = classifyMcpServer({
    url: "https://mcp.example.com/sse",
    headers: { Authorization: "Bearer xoxb_secret_token_value" },
    apiKey: "ghp_secret_token_value",
    env: { SAFE_ENV_NAME: "ghp_inline_env_secret_value", FORWARDED_ENV_NAME: "$REAL_ENV_NAME" },
  });
  assert.deepEqual(classification.envRefs, ["FORWARDED_ENV_NAME", "REAL_ENV_NAME", "SAFE_ENV_NAME"]);
});

test("clean remote server is a candidate", () => {
  const classification = classifyMcpServer({ type: "http", url: "https://mcp.linear.app/mcp" });
  assert.equal(classification.status, "candidate");
});

test("localhost url is blocked", () => {
  const classification = classifyMcpServer({ url: "http://localhost:3845/mcp" });
  assert.equal(classification.status, "blocked");
});

test("windows path counts as machine-local", () => {
  const classification = classifyMcpServer({ url: "https://x.example.com", cwd: "C:\\tools\\mcp" });
  assert.equal(classification.status, "blocked");
});

test("empty object is unsupported", () => {
  assert.equal(classifyMcpServer({}).status, "unsupported");
});

test("env ref parsing handles both dollar forms and rejects invalid names", () => {
  const scan = scanSecretReferences({ value: "prefix $ONE and ${TWO} and $2BAD and ${ALSO-BAD}" });
  assert.deepEqual(scan.envRefs, ["ONE", "TWO"]);
});

test("sensitive key detection is substring and case-insensitive", () => {
  assert.ok(isSensitiveKey("GitHub_Token"));
  assert.ok(isSensitiveKey("apiKey"));
  assert.ok(isSensitiveKey("Authorization"));
  assert.ok(!isSensitiveKey("model"));
  assert.ok(!isSensitiveKey("url"));
});
