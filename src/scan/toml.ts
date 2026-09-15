import type { JsonValue } from "./classify.js";

type TomlTable = { [key: string]: JsonValue };

// A deliberate subset of TOML 1.0: table headers, dotted/bare/quoted keys,
// strings, integers, floats, booleans, single- and multi-line arrays, and
// inline tables. Everything Codex's config.toml uses in practice. Multiline
// strings and dates are refused loudly rather than misparsed.
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let line = stripComment(lines[index] ?? "").trim();
    if (line.length === 0) continue;

    if (line.startsWith("[")) {
      const header = line.match(/^\[\[?(.+?)\]?\]$/);
      if (header?.[1] === undefined || line.startsWith("[[")) {
        throw new Error(`toml line ${index + 1}: unsupported table header.`);
      }
      current = descend(root, parseKeyPath(header[1], index + 1), index + 1);
      continue;
    }

    const equals = findEquals(line);
    if (equals === -1) throw new Error(`toml line ${index + 1}: expected key = value.`);
    const keyPath = parseKeyPath(line.slice(0, equals), index + 1);
    let valueText = line.slice(equals + 1).trim();

    while (!isBalanced(valueText)) {
      index += 1;
      if (index >= lines.length) throw new Error(`toml line ${index}: unterminated value.`);
      valueText += `\n${stripComment(lines[index] ?? "")}`;
    }

    const containerPath = keyPath.slice(0, -1);
    const finalKey = keyPath[keyPath.length - 1];
    if (finalKey === undefined) throw new Error(`toml line ${index + 1}: empty key.`);
    const container = descend(current, containerPath, index + 1);
    if (finalKey in container) throw new Error(`toml line ${index + 1}: duplicate key.`);
    container[finalKey] = parseValue(valueText.trim(), index + 1);
  }

  return root;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeKey(key: string, line: number): string {
  if (key.length === 0) throw new Error(`toml line ${line}: empty key.`);
  if (UNSAFE_KEYS.has(key)) throw new Error(`toml line ${line}: refusing key.`);
  return key;
}

function parseKeyPath(raw: string, line: number): string[] {
  const keys: string[] = [];
  let rest = raw.trim();
  while (rest.length > 0) {
    let key: string;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0] ?? '"';
      const end = rest.indexOf(quote, 1);
      if (end === -1) throw new Error(`toml line ${line}: unterminated quoted key.`);
      key = rest.slice(1, end);
      rest = rest.slice(end + 1).trim();
    } else {
      const match = rest.match(/^[A-Za-z0-9_-]+/);
      if (match === null) throw new Error(`toml line ${line}: malformed key.`);
      key = match[0];
      rest = rest.slice(key.length).trim();
    }
    keys.push(assertSafeKey(key, line));
    if (rest.startsWith(".")) rest = rest.slice(1).trim();
    else if (rest.length > 0) throw new Error(`toml line ${line}: malformed key path.`);
  }
  if (keys.length === 0) throw new Error(`toml line ${line}: empty key.`);
  return keys;
}

function descend(from: TomlTable, path: string[], line: number): TomlTable {
  let node = from;
  for (const key of path) {
    const existing = node[key];
    if (existing === undefined) {
      const next: TomlTable = {};
      node[key] = next;
      node = next;
    } else if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      node = existing as TomlTable;
    } else {
      throw new Error(`toml line ${line}: key redefines a non-table value.`);
    }
  }
  return node;
}

function parseValue(raw: string, line: number): JsonValue {
  if (raw.startsWith('"""') || raw.startsWith("'''")) {
    throw new Error(`toml line ${line}: multiline strings are not supported.`);
  }
  if (raw.startsWith('"')) return parseBasicString(raw, line);
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw new Error(`toml line ${line}: unterminated string.`);
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[")) return parseArray(raw, line);
  if (raw.startsWith("{")) return parseInlineTable(raw, line);
  if (/^[+-]?\d[\d_]*$/.test(raw)) return Number.parseInt(raw.replaceAll("_", ""), 10);
  if (/^[+-]?\d[\d_]*\.\d[\d_]*(e[+-]?\d+)?$/i.test(raw)) return Number.parseFloat(raw.replaceAll("_", ""));
  // Messages never embed file content: they flow into shareable scan reports.
  throw new Error(`toml line ${line}: unsupported value.`);
}

function parseBasicString(raw: string, line: number): string {
  if (!raw.endsWith('"') || raw.length < 2) throw new Error(`toml line ${line}: unterminated string.`);
  const body = raw.slice(1, -1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    if (character !== "\\") {
      if (character === '"') throw new Error(`toml line ${line}: stray quote in string.`);
      result += character;
      continue;
    }
    index += 1;
    const escape = body[index];
    if (escape === "n") result += "\n";
    else if (escape === "t") result += "\t";
    else if (escape === "r") result += "\r";
    else if (escape === '"') result += '"';
    else if (escape === "\\") result += "\\";
    else if (escape === "u" || escape === "U") {
      const width = escape === "u" ? 4 : 8;
      const hex = body.slice(index + 1, index + 1 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
        throw new Error(`toml line ${line}: malformed unicode escape.`);
      }
      result += String.fromCodePoint(Number.parseInt(hex, 16));
      index += width;
    } else throw new Error(`toml line ${line}: unsupported escape \\${escape ?? ""}.`);
  }
  return result;
}

function parseArray(raw: string, line: number): JsonValue[] {
  const inner = raw.slice(1, -1);
  return splitTopLevel(inner, line).map((piece) => parseValue(piece.trim(), line));
}

function parseInlineTable(raw: string, line: number): TomlTable {
  const table: TomlTable = {};
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return table;
  for (const piece of splitTopLevel(inner, line)) {
    const equals = findEquals(piece);
    if (equals === -1) throw new Error(`toml line ${line}: malformed inline table.`);
    const keys = parseKeyPath(piece.slice(0, equals), line);
    const container = descend(table, keys.slice(0, -1), line);
    const key = keys[keys.length - 1];
    if (key === undefined) throw new Error(`toml line ${line}: empty key.`);
    container[key] = parseValue(piece.slice(equals + 1).trim(), line);
  }
  return table;
}

function splitTopLevel(text: string, line: number): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inString !== null) {
      if (character === "\\" && inString === '"') index += 1;
      else if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'") inString = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      pieces.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (inString !== null) throw new Error(`toml line ${line}: unterminated string.`);
  const last = text.slice(start).trim();
  if (last.length > 0) pieces.push(text.slice(start));
  return pieces;
}

function findEquals(text: string): number {
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inString !== null) {
      if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'") inString = character;
    else if (character === "=") return index;
  }
  return -1;
}

function stripComment(line: string): string {
  let inString: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (inString !== null) {
      if (character === "\\" && inString === '"') index += 1;
      else if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'") inString = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}

function isBalanced(text: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inString !== null) {
      if (character === "\\" && inString === '"') index += 1;
      else if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'") inString = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
  }
  return depth <= 0 && inString === null;
}
