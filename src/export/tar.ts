export interface TarEntry {
  path: string;
  content: Buffer | null;
  executable?: boolean;
}

export function isRepresentablePath(name: string): boolean {
  try {
    splitName(name);
    return true;
  } catch {
    return false;
  }
}

const BLOCK = 512;
// Modes are normalized from a single input bit so identical input yields identical bytes.
const FILE_MODE = 0o644;
const EXEC_MODE = 0o755;
const DIR_MODE = 0o755;

// Minimal deterministic ustar writer: sorted entries, mtime 0, uid/gid 0,
// normalized modes. Determinism is a stated property of the bundle format.
export function createTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    const isDirectory = entry.content === null;
    const name = isDirectory ? `${entry.path.replace(/\/+$/, "")}/` : entry.path;
    const mode = isDirectory ? DIR_MODE : entry.executable === true ? EXEC_MODE : FILE_MODE;
    blocks.push(header(name, isDirectory ? 0 : entry.content!.length, isDirectory, mode));
    if (!isDirectory && entry.content!.length > 0) {
      blocks.push(entry.content!);
      const remainder = entry.content!.length % BLOCK;
      if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK - remainder));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

function header(name: string, size: number, isDirectory: boolean, mode: number): Buffer {
  const [entryName, prefix] = splitName(name);
  const block = Buffer.alloc(BLOCK);
  block.write(entryName, 0, 100, "utf8");
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(" ", 148, 156);
  block.write(isDirectory ? "5" : "0", 156, 1, "utf8");
  block.write("ustar", 257, 5, "utf8");
  block.write("00", 263, 2, "utf8");
  block.write(prefix, 345, 155, "utf8");

  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return block;
}

function splitName(name: string): [string, string] {
  if (Buffer.byteLength(name) <= 100) return [name, ""];
  for (let cut = name.length - 1; cut > 0; cut -= 1) {
    if (name[cut] !== "/") continue;
    const prefix = name.slice(0, cut);
    const rest = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest.length > 0) {
      return [rest, prefix];
    }
  }
  throw new Error(`Path too long for a ustar archive: ${name}`);
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  block.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
}
