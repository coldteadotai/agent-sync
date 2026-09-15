export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface McpClassification {
  status: "candidate" | "needs_secret" | "blocked" | "unsupported";
  reason: string;
  envRefs: string[];
}

const SENSITIVE_KEY_NEEDLES = [
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "key",
  "password",
  "secret",
  "token",
];

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_NEEDLES.some((needle) => lower.includes(needle));
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

interface SecretScan {
  envRefs: Set<string>;
  hasSecretReference: boolean;
}

export function scanSecretReferences(value: JsonValue): { envRefs: string[]; hasSecretReference: boolean } {
  const scan: SecretScan = { envRefs: new Set(), hasSecretReference: false };
  walkForSecrets(value, null, scan);
  return { envRefs: [...scan.envRefs].sort(), hasSecretReference: scan.hasSecretReference };
}

function walkForSecrets(value: JsonValue, key: string | null, scan: SecretScan): void {
  if (typeof value === "string") {
    if (key !== null && isSensitiveKey(key)) scan.hasSecretReference = true;
    collectEnvRefsFromString(value, scan);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkForSecrets(item, key, scan);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "env") collectEnvObjectRefs(childValue, scan);
      if (isSensitiveKey(childKey)) {
        scan.hasSecretReference = true;
        collectEnvRefsDeep(childValue, scan);
        continue;
      }
      walkForSecrets(childValue, childKey, scan);
    }
  }
}

function collectEnvObjectRefs(value: JsonValue, scan: SecretScan): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, childValue] of Object.entries(value)) {
      if (ENV_VAR_NAME.test(name)) {
        scan.envRefs.add(name);
        scan.hasSecretReference = true;
      }
      collectEnvRefsDeep(childValue, scan);
    }
    return;
  }
  collectEnvRefsDeep(value, scan);
}

function collectEnvRefsDeep(value: JsonValue, scan: SecretScan): void {
  if (typeof value === "string") {
    collectEnvRefsFromString(value, scan);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvRefsDeep(item, scan);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const childValue of Object.values(value)) collectEnvRefsDeep(childValue, scan);
  }
}

function collectEnvRefsFromString(text: string, scan: SecretScan): void {
  for (const match of text.matchAll(ENV_REF)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) {
      scan.envRefs.add(name);
      scan.hasSecretReference = true;
    }
  }
}

export function classifyMcpServer(value: JsonValue): McpClassification {
  const strings = collectStrings(value);
  const secrets = scanSecretReferences(value);
  const hasLocalUrl = strings.some(isLocalUrl);
  const hasRemoteUrl = strings.some(isRemoteUrl);
  const hasLocalPath = strings.some(isLocalPath);
  const executable = hasExecutableSurface(value, strings);

  if (executable || hasLocalPath || hasLocalUrl) {
    const reason = hasLocalUrl
      ? "Localhost MCP endpoints cannot work from another machine."
      : hasLocalPath
        ? "References a machine-local path that will not exist on the target."
        : "Stdio and command-based MCP servers run local programs and are never applied.";
    return { status: "blocked", reason, envRefs: secrets.envRefs };
  }

  if (secrets.hasSecretReference || secrets.envRefs.length > 0) {
    return {
      status: "needs_secret",
      reason: "References credentials or environment variables; re-enter them on the target.",
      envRefs: secrets.envRefs,
    };
  }

  if (hasRemoteUrl) {
    return {
      status: "candidate",
      reason: "Remote endpoint with no local-only dependency.",
      envRefs: secrets.envRefs,
    };
  }

  return {
    status: "unsupported",
    reason: "Not enough metadata to classify this server.",
    envRefs: secrets.envRefs,
  };
}

function hasExecutableSurface(value: JsonValue, strings: string[]): boolean {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { [key: string]: JsonValue };
    const transport = record.transport ?? record.type;
    if (typeof transport === "string") {
      const lower = transport.toLowerCase();
      if (lower.includes("stdio") || lower.includes("command")) return true;
    }
    if (record.command !== undefined || record.args !== undefined) return true;
  }
  return strings.some((item) => {
    const lower = item.toLowerCase();
    return (
      lower === "stdio" ||
      lower === "docker" ||
      lower.startsWith("docker ") ||
      lower.endsWith(".sh") ||
      lower.endsWith(".py") ||
      lower.endsWith(".js") ||
      lower.endsWith(".ts")
    );
  });
}

function collectStrings(value: JsonValue): string[] {
  const strings: string[] = [];
  const walk = (node: JsonValue): void => {
    if (typeof node === "string") {
      strings.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node !== null && typeof node === "object") {
      for (const child of Object.values(node)) walk(child);
    }
  };
  walk(value);
  return strings;
}

function isLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("~/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return true;
  return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
}

function isRemoteUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (lower.startsWith("https://") || lower.startsWith("http://")) && !isLocalUrl(value);
}

function isLocalUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("0.0.0.0") ||
    lower.includes("[::1]")
  );
}
