import { execFileSync } from "node:child_process";
import { sanitizeRemoteEndpoint } from "../scan/classify.js";
import type { ManifestMcpServer } from "../export/collect.js";

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface McpRegistration {
  name: string;
  args: string[];
}

// The manifest is untrusted input, so everything the export side sanitized is
// revalidated here before it can reach an argv.
export function planMcpRegistrations(
  servers: ManifestMcpServer[],
  requested: string[],
): McpRegistration[] {
  const byName = new Map(servers.map((server) => [server.name, server]));
  const registrations: McpRegistration[] = [];

  for (const name of requested) {
    const server = byName.get(name);
    if (server === undefined) {
      throw new Error(`--mcp ${name} does not match any server in this bundle's manifest.`);
    }
    if (server.status !== "candidate") {
      throw new Error(
        `--mcp ${name} is not portable (${server.status}): ${server.reason} Nothing was registered.`,
      );
    }
    if (server.url === undefined) {
      throw new Error(`--mcp ${name}: the bundle records no re-addable URL for this server.`);
    }
    if (!SERVER_NAME.test(name)) {
      throw new Error(`--mcp ${name}: server name is not safe to pass along. Nothing was registered.`);
    }
    const endpoint = sanitizeRemoteEndpoint(server.url);
    if (!endpoint.ok || endpoint.url === undefined) {
      throw new Error(`--mcp ${name}: ${endpoint.reason ?? "URL is not clean"}. Nothing was registered.`);
    }
    const transport = server.transport === "sse" ? "sse" : "http";
    registrations.push({
      name,
      args: ["mcp", "add", "--transport", transport, "--scope", "user", name, endpoint.url],
    });
  }

  return registrations;
}

export function runMcpRegistration(registration: McpRegistration): void {
  try {
    execFileSync("claude", registration.args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail =
      error !== null && typeof error === "object" && "stderr" in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString("utf8").trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`registering MCP server ${registration.name} via \`claude mcp add\` failed: ${detail}`);
  }
}
