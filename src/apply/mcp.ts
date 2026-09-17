import { execFileSync } from "node:child_process";
import { sanitizeRemoteEndpoint } from "../scan/classify.js";
import type { ManifestMcpServer } from "../export/collect.js";

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ARGS = 64;
const MAX_ENV_NAMES = 32;
const MAX_STRING_LENGTH = 2000;

export interface McpRegistration {
  name: string;
  args: string[];
}

// Env values for a stdio server are resolved ON the applying machine, never
// carried: the guided flow prompts for them, the static path reads the
// target's own environment.
export type McpEnvResolver = (server: string, envName: string) => string | undefined;

export function processEnvResolver(env: Record<string, string | undefined> = process.env): McpEnvResolver {
  return (_server, envName) => env[envName];
}

// The manifest is untrusted input, so everything the export side sanitized is
// revalidated here before it can reach an argv. Stdio entries get the full
// treatment: name shape, control-byte-free strings, env-name shape, and size
// caps — then argv assembly with no shell anywhere.
export function planMcpRegistrations(
  servers: ManifestMcpServer[],
  requested: string[],
  resolveEnv: McpEnvResolver = processEnvResolver(),
): McpRegistration[] {
  const byName = new Map(servers.map((server) => [server.name, server]));
  const registrations: McpRegistration[] = [];

  for (const name of requested) {
    const server = byName.get(name);
    if (server === undefined) {
      throw new Error(`--mcp ${name} does not match any server in this bundle's manifest.`);
    }
    if (!SERVER_NAME.test(name)) {
      throw new Error(`--mcp ${name}: server name is not safe to pass along. Nothing was registered.`);
    }
    if (server.transport === "stdio" || server.command !== undefined) {
      registrations.push(planStdioRegistration(name, server, resolveEnv));
      continue;
    }
    if (server.status !== "candidate") {
      throw new Error(
        `--mcp ${name} is not portable (${server.status}): ${server.reason} Nothing was registered.`,
      );
    }
    if (server.url === undefined) {
      throw new Error(`--mcp ${name}: the bundle records no re-addable URL for this server.`);
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

function planStdioRegistration(
  name: string,
  server: ManifestMcpServer,
  resolveEnv: McpEnvResolver,
): McpRegistration {
  if (typeof server.command !== "string" || !cleanString(server.command)) {
    throw new Error(`--mcp ${name}: the bundle's command is not a clean string. Nothing was registered.`);
  }
  const args = server.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((arg) => typeof arg === "string" && cleanString(arg))) {
    throw new Error(`--mcp ${name}: the bundle's args are not clean strings. Nothing was registered.`);
  }
  const envNames = server.envNames ?? [];
  if (
    !Array.isArray(envNames) ||
    envNames.length > MAX_ENV_NAMES ||
    !envNames.every((envName) => typeof envName === "string" && ENV_NAME.test(envName))
  ) {
    throw new Error(`--mcp ${name}: the bundle's env names are not valid variable names. Nothing was registered.`);
  }

  const argv = ["mcp", "add", "--transport", "stdio", "--scope", "user", name];
  for (const envName of envNames) {
    const value = resolveEnv(name, envName);
    if (value === undefined || value.length === 0) {
      throw new Error(
        `--mcp ${name} needs ${envName}: set it in this machine's environment (or run the guided apply, which asks for it). Values are never carried in bundles.`,
      );
    }
    argv.push("--env", `${envName}=${value}`);
  }
  argv.push("--", server.command, ...args);
  return { name, args: argv };
}

function cleanString(text: string): boolean {
  return text.length > 0 && text.length <= MAX_STRING_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

// A missing binary is a warning, not a refusal: the registration still
// lands, and the user may well install the runner right after applying.
export function commandOnPath(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [command], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
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
