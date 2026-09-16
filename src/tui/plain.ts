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

  constructor(io?: Partial<PlainIo>) {
    this.io = {
      input: io?.input ?? process.stdin,
      output: io?.output ?? process.stderr,
    };
  }

  say(line: string): void {
    this.io.output.write(`${line}\n`);
  }

  private ask(question: string): Promise<string | null> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: this.io.input,
        output: this.io.output as NodeJS.WritableStream,
        terminal: false,
      });
      let settled = false;
      const finish = (answer: string | null): void => {
        if (settled) return;
        settled = true;
        rl.close();
        resolve(answer);
      };
      this.io.output.write(`${question}\n> `);
      rl.once("line", (line) => finish(line));
      rl.once("close", () => finish(null));
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

  async select<T>(message: string, items: MultiItem<T>[]): Promise<PromptResult<T>> {
    for (;;) {
      const listing = items
        .map((item, index) => `  ${index + 1}. ${item.label}${item.hint ? ` (${item.hint})` : ""}`)
        .join("\n");
      const answer = await this.ask(`${message}\n${listing}\nEnter a number:`);
      if (answer === null) return cancelled();
      const index = Number.parseInt(answer.trim(), 10) - 1;
      const chosen = items[index];
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
        const indexes = text.split(/[\s,]+/).map((piece) => Number.parseInt(piece, 10) - 1);
        if (indexes.some((index) => Number.isNaN(index) || selectable[index] === undefined)) {
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

export function plainModeRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env.AGENT_SYNC_ACCESSIBLE === "1" || env.TERM === "dumb";
}
