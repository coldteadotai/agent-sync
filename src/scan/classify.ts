export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface McpClassification {
  status: "candidate" | "needs_secret" | "blocked" | "unsupported";
  reason: string;
  envRefs: string[];
  url?: string;
  transport?: "http" | "sse";
}

export interface EndpointCheck {
  ok: boolean;
  url?: string;
  reason?: string;
}

// A URL is only re-declarable when it cannot carry a secret: no userinfo, no
// query, no fragment. Everything else stays name-only in reports and bundles.
export function sanitizeRemoteEndpoint(raw: string): EndpointCheck {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "URL does not parse" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "URL is not http(s)" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "URL embeds credentials" };
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return { ok: false, reason: "URL carries query or fragment parameters" };
  }
  return { ok: true, url: parsed.toString() };
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
      if (childKey === "env") {
        collectEnvObjectRefs(childValue, scan);
        continue;
      }
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
    collectEnvRefsFromStringStrict(value, scan);
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

// Strings under sensitive keys and env values are often literal secrets; a `$`
// inside one would emit a fragment of the secret as a "name". Accept only the
// braced form there, or a bare ref that is the entire string.
function collectEnvRefsFromStringStrict(text: string, scan: SecretScan): void {
  const whole = text.trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (whole?.[1] !== undefined) {
    scan.envRefs.add(whole[1]);
    scan.hasSecretReference = true;
    return;
  }
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (match[1] !== undefined) {
      scan.envRefs.add(match[1]);
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
    const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    const rawUrl = record !== null && typeof record.url === "string" ? record.url : null;
    const endpoint = rawUrl === null ? null : sanitizeRemoteEndpoint(rawUrl);
    if (endpoint !== null && !endpoint.ok && endpoint.reason !== "URL does not parse") {
      return {
        status: "needs_secret",
        reason: `Server ${endpoint.reason ?? "URL is not clean"}; re-add it manually on the target.`,
        envRefs: secrets.envRefs,
      };
    }
    const transportValue = record === null ? null : (record.type ?? record.transport);
    const classification: McpClassification = {
      status: "candidate",
      reason: "Remote endpoint with no local-only dependency.",
      envRefs: secrets.envRefs,
    };
    if (endpoint !== null && endpoint.ok && endpoint.url !== undefined) {
      classification.url = endpoint.url;
      classification.transport = transportValue === "sse" ? "sse" : "http";
    }
    return classification;
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
