import * as readline from "node:readline";
import type { MultiGroup, MultiItem, PromptResult } from "./components.js";
import { cancelled, done } from "./components.js";

export interface PlainIo {
  input: NodeJS.ReadableStream;
  output: { write(chunk: string): unknown };
}

// The accessible path: numbered lists, [x] markers, literal questions, zero
// repaints. Screen-reader users run real TTYs; this mode speaks the same flow
// the picker draws.
export class Plain {
  private io: PlainIo;
  private rl: readline.Interface | null = null;
  private lines: string[] = [];
  private waiters: ((line: string | null) => void)[] = [];
  private ended = false;

  constructor(io?: Partial<PlainIo>) {
    this.io = {
      input: io?.input ?? process.stdin,
      output: io?.output ?? process.stderr,
    };
  }

  say(line: string): void {
    this.io.output.write(`${line}\n`);
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  // One long-lived interface: piped stdin delivers many answers in one chunk,
  // and a per-question interface would swallow every line after the first.
  private ensureInterface(): void {
    if (this.rl !== null || this.ended) return;
    this.rl = readline.createInterface({
      input: this.io.input,
      terminal: false,
    });
    this.rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  private ask(question: string): Promise<string | null> {
    this.ensureInterface();
    this.io.output.write(`${question}\n> `);
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async confirm(message: string, initial = false): Promise<PromptResult<boolean>> {
    for (;;) {
      const answer = await this.ask(`${message} [${initial ? "Y/n" : "y/N"}]`);
      if (answer === null) return cancelled();
      const text = answer.trim().toLowerCase();
      if (text === "") return done(initial);
      if (text === "y" || text === "yes") return done(true);
      if (text === "n" || text === "no") return done(false);
      this.say("Please answer y or n.");
    }
  }

  // Plain mode cannot mask input (it reads cooked lines), so it says so
  // before asking; the value still never appears in any later output.
  async secret(message: string): Promise<PromptResult<string>> {
    for (;;) {
      const answer = await this.ask(`${message} (input is visible in this mode)`);
      if (answer === null) return cancelled();
      if (answer.trim().length > 0) return done(answer.trim());
      this.say("A value is required, or ctrl+c to cancel.");
    }
  }

  async select<T>(message: string, items: MultiItem<T>[]): Promise<PromptResult<T>> {
    for (;;) {
      const listing = items
        .map((item, index) => `  ${index + 1}. ${item.label}${item.hint ? ` (${item.hint})` : ""}`)
        .join("\n");
      const answer = await this.ask(`${message}\n${listing}\nEnter a number:`);
      if (answer === null) return cancelled();
      const pieces = parsePieces(answer);
      const index = pieces?.[0];
      const chosen = index === undefined ? undefined : items[index];
      if (chosen !== undefined) return done(chosen.value);
      this.say(`Enter a number between 1 and ${items.length}.`);
    }
  }

  async groupMultiselect<T>(
    message: string,
    groups: MultiGroup<T>[],
    options: { required?: boolean } = {},
  ): Promise<PromptResult<T[]>> {
    const selectable: (MultiItem<T> & { group: string })[] = [];
    for (const group of groups) {
      if (group.locked) continue;
      for (const item of group.items) selectable.push({ ...item, group: group.title });
    }

    const lockedNote = groups
      .filter((group) => group.locked)
      .map((group) => `${group.title}: ${group.items.map((item) => item.label).join(", ")} (never included)`)
      .join("\n");
    if (lockedNote.length > 0) this.say(lockedNote);

    if (selectable.length === 0) return done([]);

    const listing = selectable
      .map((item, index) => {
        const mark = item.preselected ? "[x]" : "[ ]";
        return `  ${index + 1}. ${mark} ${item.label} (${item.group}${item.hint ? `, ${item.hint}` : ""})`;
      })
      .join("\n");

    for (;;) {
      const answer = await this.ask(
        `${message}\n${listing}\nEnter numbers like 1,3, or 'all', or 'none'${options.required ? "" : " (enter keeps the [x] defaults)"}:`,
      );
      if (answer === null) return cancelled();
      const text = answer.trim().toLowerCase();
      let picked: (MultiItem<T> & { group: string })[];
      if (text === "all") picked = selectable;
      else if (text === "none") picked = [];
      else if (text === "") picked = selectable.filter((item) => item.preselected);
      else {
        const indexes = parsePieces(text);
        if (indexes === null || indexes.some((index) => selectable[index] === undefined)) {
          this.say(`Use numbers between 1 and ${selectable.length}, separated by commas.`);
          continue;
        }
        picked = [...new Set(indexes)].map((index) => selectable[index]) as typeof selectable;
      }
      if (options.required && picked.length === 0) {
        this.say("Select at least one item.");
        continue;
      }
      return done(picked.map((item) => item.value));
    }
  }
}

function parsePieces(text: string): number[] | null {
  const pieces = text
    .trim()
    .split(/[\s,]+/)
    .filter((piece) => piece.length > 0);
  if (pieces.length === 0) return null;
  const indexes: number[] = [];
  for (const piece of pieces) {
    if (!/^\d+$/.test(piece)) return null;
    indexes.push(Number.parseInt(piece, 10) - 1);
  }
  return indexes;
}

export function plainModeRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env.AGENT_SYNC_ACCESSIBLE === "1" || env.TERM === "dumb";
}
