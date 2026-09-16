import * as readline from "node:readline";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  char: string | null;
}

export interface ScreenInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  readableEnded?: boolean;
  destroyed?: boolean;
}

export interface ScreenOutput {
  write(chunk: string): unknown;
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

// Display-cell width with the same conservative table the exemplars use:
// CJK, Hangul, and emoji ranges count as two cells; everything else as one.
export function visualWidth(text: string): number {
  const plain = stripVTControlCharacters(text);
  let width = 0;
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

// Truncate to a visual width, preserving ANSI sequences and closing style at
// the cut. Rendered lines always fit the terminal, so cursor math can never
// be corrupted by wrapping (the Windows prompt-duplication bug class).
export function visualTruncate(line: string, maxWidth: number): string {
  if (visualWidth(line) <= maxWidth) return line;
  let width = 0;
  let out = "";
  let index = 0;
  const budget = Math.max(0, maxWidth - 1);
  while (index < line.length) {
    const escape = line.slice(index).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
    if (escape !== null) {
      out += escape[0];
      index += escape[0].length;
      continue;
    }
    const character = String.fromCodePoint(line.codePointAt(index) ?? 0);
    const characterWidth = isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + characterWidth > budget) break;
    out += character;
    width += characterWidth;
    index += character.length;
  }
  return `${out}…\x1b[0m`;
}

export interface ScreenOptions {
  input?: ScreenInput;
  output?: ScreenOutput;
}

export class Screen {
  private input: ScreenInput;
  private output: ScreenOutput;
  private rl: readline.Interface | null = null;
  private liveRows = 0;
  private lastLive: string[] = [];
  private keyListener: ((key: Key) => void) | null = null;
  // Keys arriving while no waiter is attached (pasted bursts, fast typists)
  // queue instead of dropping; waitKey drains the queue first.
  private keyQueue: Key[] = [];
  private opened = false;
  private restore: (() => void) | null = null;
  private resizeHandler = (): void => {
    if (this.lastLive.length > 0) this.renderLive(this.lastLive);
  };

  constructor(options: ScreenOptions = {}) {
    this.input = options.input ?? (process.stdin as ScreenInput);
    // All interactive UI renders on stderr; stdout stays a pipe.
    this.output = options.output ?? (process.stderr as unknown as ScreenOutput);
  }

  get columns(): number {
    return this.output.columns ?? 80;
  }

  get rows(): number {
    return this.output.rows ?? 24;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    const devnull = new Writable({ write: (_c, _e, cb) => cb() });
    this.rl = readline.createInterface({
      input: this.input as unknown as NodeJS.ReadableStream,
      output: devnull,
      terminal: true,
      escapeCodeTimeout: 50,
    });
    readline.emitKeypressEvents(this.input as unknown as NodeJS.ReadableStream, this.rl);
    if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(true);
    this.input.on("keypress", this.onKeypress);
    this.input.on("end", this.onEof);
    this.input.on("close", this.onEof);
    this.output.on?.("resize", this.resizeHandler);
    process.on("SIGWINCH", noop);
    this.write("\x1b[?25l");
    const restore = (): void => this.close();
    this.restore = restore;
    process.on("exit", restore);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.write("\x1b[?25h");
    this.input.removeListener("keypress", this.onKeypress);
    this.input.removeListener("end", this.onEof);
    this.input.removeListener("close", this.onEof);
    this.output.off?.("resize", this.resizeHandler);
    process.removeListener("SIGWINCH", noop);
    if (this.restore) process.removeListener("exit", this.restore);
    // Windows: skip rawMode(false) churn issues by only lowering when raised,
    // and detach readline's terminal handling before close (node#31762).
    if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(false);
    if (this.rl) {
      (this.rl as unknown as { terminal: boolean }).terminal = false;
      this.rl.close();
      this.rl = null;
    }
  }

  onKey(listener: ((key: Key) => void) | null): void {
    this.keyListener = listener;
  }

  waitKey(): Promise<Key> {
    const queued = this.keyQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.onKey((key) => {
        this.onKey(null);
        resolve(key);
      });
    });
  }

  // Permanent lines scroll into history; the live region repaints below them.
  commit(lines: string[]): void {
    this.clearLive();
    for (const line of lines) this.write(`${this.fit(line)}\n`);
    if (this.lastLive.length > 0) this.renderLive(this.lastLive);
  }

  renderLive(lines: string[]): void {
    const budget = Math.max(1, this.rows - 1);
    const fitted = lines.slice(0, budget).map((line) => this.fit(line));
    const up = this.liveRows > 0 ? `\x1b[${this.liveRows}A` : "";
    this.write(`\r${up}\x1b[J${fitted.join("\n")}${fitted.length > 0 ? "\n" : ""}`);
    this.liveRows = fitted.length;
    this.lastLive = lines;
  }

  clearLive(): void {
    if (this.liveRows === 0) return;
    this.write(`\r\x1b[${this.liveRows}A\x1b[J`);
    this.liveRows = 0;
    this.lastLive = [];
  }

  private fit(line: string): string {
    return visualTruncate(line, Math.max(4, this.columns - 1));
  }

  private write(text: string): void {
    this.output.write(text);
  }

  private onKeypress = (char: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } | undefined): void => {
    const name = key?.name ?? "";
    const sequence = key?.sequence ?? char ?? "";
    const printable =
      sequence.length === 1 && !key?.ctrl && !key?.meta && sequence >= " " ? sequence : null;
    this.deliver({
      name: key?.ctrl && name === "c" ? "cancel" : name === "escape" ? "escape" : name,
      ctrl: key?.ctrl ?? false,
      meta: key?.meta ?? false,
      shift: key?.shift ?? false,
      char: printable,
    });
  };

  private deliver(key: Key): void {
    if (this.keyListener) this.keyListener(key);
    else if (this.keyQueue.length < 64) this.keyQueue.push(key);
  }

  private onEof = (): void => {
    // Stdin ending mid-prompt must cancel, never hang (the CI trap).
    this.deliver({ name: "cancel", ctrl: false, meta: false, shift: false, char: null });
  };
}

function noop(): void {}
