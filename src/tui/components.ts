import type { Key, Screen } from "./terminal.js";
import type { Theme } from "./theme.js";

export type PromptResult<T> = { cancelled: true } | { cancelled: false; value: T };

export function cancelled(): { cancelled: true } {
  return { cancelled: true };
}

export function done<T>(value: T): { cancelled: false; value: T } {
  return { cancelled: false, value };
}

export interface MultiItem<T> {
  value: T;
  label: string;
  hint?: string;
  preselected?: boolean;
}

export interface MultiGroup<T> {
  title: string;
  items: MultiItem<T>[];
  locked?: boolean;
  lockedReason?: string;
}

export interface Flow {
  intro(title: string, subtitle?: string): void;
  note(lines: string[]): void;
  outro(text: string): void;
  confirm(message: string, initial?: boolean): Promise<PromptResult<boolean>>;
  select<T>(message: string, items: MultiItem<T>[]): Promise<PromptResult<T>>;
  groupMultiselect<T>(message: string, groups: MultiGroup<T>[], options?: { required?: boolean }): Promise<PromptResult<T[]>>;
}

interface Row<T> {
  kind: "header" | "item";
  groupIndex: number;
  item?: MultiItem<T> & { id: number };
}

interface MultiState<T> {
  message: string;
  groups: MultiGroup<T>[];
  items: (MultiItem<T> & { id: number; groupIndex: number })[];
  selected: Set<number>;
  cursor: number;
  query: string;
  filtering: boolean;
  error: string | null;
  required: boolean;
}

export function buildMultiState<T>(
  message: string,
  groups: MultiGroup<T>[],
  options: { required?: boolean } = {},
): MultiState<T> {
  const items: MultiState<T>["items"] = [];
  let id = 0;
  groups.forEach((group, groupIndex) => {
    if (group.locked) return;
    for (const item of group.items) items.push({ ...item, id: id++, groupIndex });
  });
  return {
    message,
    groups,
    items,
    selected: new Set(items.filter((item) => item.preselected).map((item) => item.id)),
    cursor: 0,
    query: "",
    filtering: false,
    error: null,
    required: options.required ?? false,
  };
}

export function visibleItems<T>(state: MultiState<T>): MultiState<T>["items"] {
  if (state.query.length === 0) return state.items;
  const query = state.query.toLowerCase();
  return state.items.filter((item) => item.label.toLowerCase().includes(query));
}

export type MultiOutcome<T> = { kind: "continue" } | { kind: "submit"; values: T[] } | { kind: "cancel" };

export function reduceMulti<T>(state: MultiState<T>, key: Key): MultiOutcome<T> {
  state.error = null;
  const visible = visibleItems(state);
  const clamp = (): void => {
    state.cursor = Math.min(Math.max(state.cursor, 0), Math.max(0, visible.length - 1));
  };

  if (key.name === "cancel") return { kind: "cancel" };
  if (key.name === "escape") {
    if (state.filtering || state.query.length > 0) {
      state.filtering = false;
      state.query = "";
      state.cursor = 0;
      return { kind: "continue" };
    }
    return { kind: "cancel" };
  }
  if (key.name === "return" || key.name === "enter") {
    if (state.required && state.selected.size === 0) {
      state.error = "Select at least one item, or cancel.";
      return { kind: "continue" };
    }
    const chosen = state.items.filter((item) => state.selected.has(item.id)).map((item) => item.value);
    return { kind: "submit", values: chosen };
  }

  if (state.filtering) {
    if (key.name === "backspace") {
      state.query = state.query.slice(0, -1);
      clamp();
      return { kind: "continue" };
    }
    if (key.name === "up" || key.name === "down" || key.name === "tab") {
      state.filtering = false;
    } else if (key.char !== null) {
      state.query += key.char;
      state.cursor = 0;
      return { kind: "continue" };
    } else {
      return { kind: "continue" };
    }
  }

  const current = visible[state.cursor];
  switch (true) {
    case key.name === "up" || key.char === "k":
      state.cursor = visible.length === 0 ? 0 : (state.cursor - 1 + visible.length) % visible.length;
      return { kind: "continue" };
    case key.name === "down" || key.char === "j":
      state.cursor = visible.length === 0 ? 0 : (state.cursor + 1) % visible.length;
      return { kind: "continue" };
    case key.name === "space": {
      if (current) toggle(state, current.id);
      return { kind: "continue" };
    }
    case key.name === "tab": {
      if (current) toggle(state, current.id);
      state.cursor = visible.length === 0 ? 0 : (state.cursor + 1) % visible.length;
      return { kind: "continue" };
    }
    case key.char === "a": {
      if (!current) return { kind: "continue" };
      // With a filter active, bulk operations touch only what the user can
      // see: selection must never change without a visual trace.
      const scope =
        state.query.length > 0
          ? visible
          : state.items.filter((item) => item.groupIndex === current.groupIndex);
      const allOn = scope.every((item) => state.selected.has(item.id));
      for (const item of scope) {
        if (allOn) state.selected.delete(item.id);
        else state.selected.add(item.id);
      }
      return { kind: "continue" };
    }
    case key.char === "i": {
      const scope = state.query.length > 0 ? visible : state.items;
      for (const item of scope) {
        if (state.selected.has(item.id)) state.selected.delete(item.id);
        else state.selected.add(item.id);
      }
      return { kind: "continue" };
    }
    case key.char === "/":
      state.filtering = true;
      return { kind: "continue" };
    default:
      return { kind: "continue" };
  }
}

function toggle<T>(state: MultiState<T>, id: number): void {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
}

const RULE_WIDTH = 44;

export function renderMulti<T>(state: MultiState<T>, theme: Theme, maxRows: number): string[] {
  const g = theme.glyphs;
  const bar = theme.paint("accent", g.bar);
  const visible = visibleItems(state);
  const lines: string[] = [];

  const counts =
    state.query.length > 0
      ? `${visible.length}/${state.items.length} (${state.selected.size} selected)`
      : `${state.selected.size} of ${state.items.length} selected`;
  lines.push(`${theme.paint("accent", g.stepActive)}  ${theme.paint("bright", state.message)}  ${theme.paint("dim", counts)}`);
  if (state.filtering || state.query.length > 0) {
    lines.push(`${bar}  ${theme.paint("accent", "/")} ${state.query}${state.filtering ? theme.paint("inverse", " ") : ""}`);
  }

  const rows: string[] = [];
  let lastGroup = -1;
  visible.forEach((item, index) => {
    if (item.groupIndex !== lastGroup) {
      lastGroup = item.groupIndex;
      const group = state.groups[item.groupIndex];
      if (group) {
        const title = ` ${group.title} `;
        rows.push(`${bar}  ${theme.paint("dim", `${g.rule.repeat(2)}${title}${g.rule.repeat(Math.max(0, RULE_WIDTH - title.length))}`)}`);
      }
    }
    const active = index === state.cursor;
    const mark = state.selected.has(item.id) ? theme.paint("ok", g.checkOn) : g.checkOff;
    const label = active ? theme.paint("bright", item.label) : item.label;
    const hint = item.hint ? `  ${theme.paint("dim", item.hint)}` : "";
    rows.push(`${bar}  ${active ? theme.paint("accent", g.pointer) : " "} ${mark} ${label}${hint}`);
  });
  if (visible.length === 0) rows.push(`${bar}  ${theme.paint("dim", "No matches.")}`);

  let lockedLines: string[] = [];
  let lockedCount = 0;
  state.groups.forEach((group) => {
    if (!group.locked) return;
    lockedCount += group.items.length;
    const title = ` ${group.title} `;
    lockedLines.push(`${bar}  ${theme.paint("dim", `${g.rule.repeat(2)}${title}${g.rule.repeat(Math.max(0, RULE_WIDTH - title.length))}`)}`);
    for (const item of group.items) {
      lockedLines.push(`${bar}  ${theme.paint("dim", `${g.lockedMark} ${item.label}${item.hint ? `  ${item.hint}` : ""}`)}`);
    }
    if (group.lockedReason) lockedLines.push(`${bar}  ${theme.paint("dim", `  ${group.lockedReason}`)}`);
  });

  const sep = ` ${g.sep} `;
  const footer: string[] = [];
  if (state.error) footer.push(`${theme.paint("warn", g.stepError)}  ${theme.paint("warn", state.error)}`);
  footer.push(
    `${theme.paint("accent", g.railEnd)}  ${theme.paint(
      "dim",
      [`${g.navUpDown} move`, "space select", "tab next", "a group", "i invert", "/ filter", "enter confirm"].join(sep),
    )}`,
  );

  // Short terminals: locked lines collapse to one before the list shrinks
  // below usable, and the footer and error are never the rows that get cut.
  let overhead = lines.length + lockedLines.length + footer.length;
  if (lockedCount > 0 && overhead + 3 > maxRows) {
    lockedLines = [
      `${bar}  ${theme.paint("dim", `${g.lockedMark} ${lockedCount} item(s) never leave this machine`)}`,
    ];
    overhead = lines.length + lockedLines.length + footer.length;
  }
  const budget = Math.max(3, maxRows - overhead);
  const windowed = windowRows(rows, cursorRowIndex(state, visible), budget, theme);
  return [...lines, ...windowed, ...lockedLines, ...footer];
}

function cursorRowIndex<T>(state: MultiState<T>, visible: MultiState<T>["items"]): number {
  let row = 0;
  let lastGroup = -1;
  for (let index = 0; index < visible.length; index += 1) {
    const item = visible[index];
    if (item && item.groupIndex !== lastGroup) {
      lastGroup = item.groupIndex;
      row += 1;
    }
    if (index === state.cursor) return row;
    row += 1;
  }
  return row;
}

function windowRows(rows: string[], cursorRow: number, budget: number, theme: Theme): string[] {
  if (rows.length <= budget) return rows;
  const g = theme.glyphs;
  const inner = budget - 2;
  let start = Math.max(0, Math.min(cursorRow - Math.floor(inner / 2), rows.length - inner));
  const end = Math.min(rows.length, start + inner);
  const out: string[] = [];
  const bar = theme.paint("accent", g.bar);
  out.push(`${bar}  ${theme.paint("dim", start > 0 ? `${g.ellipsisUp} ${start} more` : " ")}`);
  out.push(...rows.slice(start, end));
  out.push(`${bar}  ${theme.paint("dim", end < rows.length ? `${g.ellipsisDown} ${rows.length - end} more` : " ")}`);
  return out;
}

export function createFlow(screen: Screen, theme: Theme): Flow {
  const g = theme.glyphs;
  const bar = theme.paint("accent", g.bar);

  const summaryCommit = (message: string, summary: string): void => {
    screen.commit([
      `${theme.paint("ok", g.stepDone)}  ${message} ${theme.paint("dim", `${g.sep} ${summary}`)}`,
      bar,
    ]);
  };
  const cancelCommit = (message: string): void => {
    screen.commit([
      `${theme.paint("bad", g.stepError)}  ${theme.paint("strike", message)}`,
      `${theme.paint("accent", g.railEnd)}  ${theme.paint("bright", "Cancelled. Nothing was written.")}`,
    ]);
    screen.close();
  };

  return {
    intro(title, subtitle) {
      screen.open();
      screen.commit([
        `${theme.paint("accent", g.railStart)}  ${theme.paint("bright", title)}${subtitle ? ` ${theme.paint("dim", subtitle)}` : ""}`,
        bar,
      ]);
    },
    note(lines) {
      screen.commit(lines.map((line) => `${bar}  ${line}`).concat(bar));
    },
    outro(text) {
      screen.commit([`${theme.paint("accent", g.railEnd)}  ${theme.paint("dim", text)}`]);
      screen.close();
    },

    async confirm(message, initial = true) {
      let value = initial;
      for (;;) {
        const yes = value ? theme.paint("inverse", " Yes ") : " Yes ";
        const no = value ? " No " : theme.paint("inverse", " No ");
        screen.renderLive([
          `${theme.paint("accent", g.stepActive)}  ${theme.paint("bright", message)}`,
          `${bar}  ${yes} ${theme.paint("dim", "/")} ${no}`,
          `${theme.paint("accent", g.railEnd)}  ${theme.paint(
            "dim",
            [`${g.navLeftRight} choose`, "y/n", "enter confirm"].join(` ${g.sep} `),
          )}`,
        ]);
        const key = await screen.waitKey();
        if (key.name === "cancel" || key.name === "escape") {
          cancelCommit(message);
          return cancelled();
        }
        const lower = key.char?.toLowerCase();
        if (lower === "y") value = true;
        else if (lower === "n") value = false;
        else if (key.name === "left" || key.name === "right" || key.char === "h" || key.char === "l") value = !value;
        else if (key.name === "return" || key.name === "enter") {
          screen.clearLive();
          summaryCommit(message, value ? "yes" : "no");
          return done(value);
        }
      }
    },

    async select(message, items) {
      if (items.length === 0) throw new Error("select needs at least one option.");
      let cursor = 0;
      for (;;) {
        const rows = items.map((item, index) => {
          const active = index === cursor;
          const mark = active ? theme.paint("accent", g.radioOn) : g.radioOff;
          const hint = item.hint ? `  ${theme.paint("dim", item.hint)}` : "";
          return `${bar}  ${mark} ${active ? theme.paint("bright", item.label) : item.label}${hint}`;
        });
        const windowed = windowRows(rows, cursor, Math.max(3, screen.rows - 4), theme);
        screen.renderLive([
          `${theme.paint("accent", g.stepActive)}  ${theme.paint("bright", message)}`,
          ...windowed,
          `${theme.paint("accent", g.railEnd)}  ${theme.paint(
            "dim",
            [`${g.navUpDown} move`, "enter confirm"].join(` ${g.sep} `),
          )}`,
        ]);
        const key = await screen.waitKey();
        if (key.name === "cancel" || key.name === "escape") {
          cancelCommit(message);
          return cancelled();
        }
        if (key.name === "up" || key.char === "k") cursor = (cursor - 1 + items.length) % items.length;
        else if (key.name === "down" || key.char === "j") cursor = (cursor + 1) % items.length;
        else if (key.name === "return" || key.name === "enter") {
          const chosen = items[cursor];
          if (!chosen) continue;
          screen.clearLive();
          summaryCommit(message, chosen.label);
          return done(chosen.value);
        }
      }
    },

    async groupMultiselect(message, groups, options = {}) {
      const state = buildMultiState(message, groups, options);
      for (;;) {
        screen.renderLive(renderMulti(state, theme, Math.max(6, screen.rows - 2)));
        const outcome = reduceMulti(state, await screen.waitKey());
        if (outcome.kind === "cancel") {
          cancelCommit(message);
          return cancelled();
        }
        if (outcome.kind === "submit") {
          screen.clearLive();
          const labels = state.items
            .filter((item) => state.selected.has(item.id))
            .map((item) => item.label);
          const summary =
            labels.length === 0
              ? "none"
              : labels.length <= 3
                ? labels.join(", ")
                : `${labels.slice(0, 3).join(", ")} +${labels.length - 3} more`;
          summaryCommit(message, summary);
          return done(outcome.values);
        }
      }
    },
  };
}
