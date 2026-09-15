import { gunzipSync } from "node:zlib";

export interface UntarEntry {
  path: string;
  type: "file" | "directory";
  executable: boolean;
  content: Buffer;
}

const BLOCK = 512;

export function parseTar(input: Buffer): UntarEntry[] {
  const buffer = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const entries: UntarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;

    verifyChecksum(block, offset);
    const rawName = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const name = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const size = readOctal(block, 124, 12);
    const mode = readOctal(block, 100, 8);
    const typeflag = String.fromCharCode(block[156] ?? 0);

    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
      throw new Error(`Refusing archive entry ${name}: unsupported type '${typeflag}' (symlinks, links and extensions are not part of the bundle format).`);
    }

    const isDirectory = typeflag === "5";
    const path = validateArchivePath(name, isDirectory);
    if (seen.has(path)) throw new Error(`Refusing archive: duplicate entry ${path}.`);
    seen.add(path);

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`Refusing archive: entry ${path} is truncated.`);

    entries.push({
      path,
      type: isDirectory ? "directory" : "file",
      executable: (mode & 0o100) !== 0,
      content: isDirectory ? Buffer.alloc(0) : Buffer.from(buffer.subarray(dataStart, dataEnd)),
    });

    const padded = size === 0 ? 0 : Math.ceil(size / BLOCK) * BLOCK;
    offset = dataStart + padded;
  }

  return entries;
}

export function validateArchivePath(name: string, allowTrailingSlash: boolean): string {
  const trimmed = allowTrailingSlash ? name.replace(/\/+$/, "") : name;
  if (trimmed.length === 0) throw new Error("Refusing archive: empty entry name.");
  if (trimmed.includes("\\")) throw new Error(`Refusing archive entry ${name}: backslash in path.`);
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`Refusing archive entry ${name}: absolute path.`);
  }
  for (const component of trimmed.split("/")) {
    if (component === "" || component === "." || component === "..") {
      throw new Error(`Refusing archive entry ${name}: path traversal component.`);
    }
  }
  return trimmed;
}

function verifyChecksum(block: Buffer, offset: number): void {
  const stored = readOctal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  if (sum !== stored) throw new Error(`Refusing archive: header checksum mismatch at byte ${offset}.`);
}

function readString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
}

function readOctal(block: Buffer, start: number, length: number): number {
  const text = readString(block, start, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value) || value < 0) throw new Error("Refusing archive: malformed octal header field.");
  return value;
}
