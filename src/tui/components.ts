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
  groupMultiselect<T>(message: string, groups: MultiGroup<T>[], options?: { required?: boolean; coach?: string }): Promise<PromptResult<T[]>>;
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
  // The coach line teaches space-vs-enter until the first toggle proves the
  // lesson landed (null = the default wording, rendered with theme glyphs);
  // the two view toggles belong to the state so a repaint cannot lose them.
  coach: string | null;
  touched: boolean;
  lockedExpanded: boolean;
  helpExpanded: boolean;
}

export function buildMultiState<T>(
  message: string,
  groups: MultiGroup<T>[],
  options: { required?: boolean; coach?: string } = {},
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
    coach: options.coach ?? null,
    touched: false,
    lockedExpanded: false,
    helpExpanded: false,
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
      state.touched = true;
      return { kind: "continue" };
    }
    case key.name === "tab": {
      if (current) toggle(state, current.id);
      state.touched = true;
      state.cursor = visible.length === 0 ? 0 : (state.cursor + 1) % visible.length;
      return { kind: "continue" };
    }
    case key.char === "v": {
      state.lockedExpanded = !state.lockedExpanded;
      return { kind: "continue" };
    }
    case key.char === "?": {
      state.helpExpanded = !state.helpExpanded;
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
      state.touched = true;
      return { kind: "continue" };
    }
    case key.char === "i": {
      const scope = state.query.length > 0 ? visible : state.items;
      for (const item of scope) {
        if (state.selected.has(item.id)) state.selected.delete(item.id);
        else state.selected.add(item.id);
      }
      state.touched = true;
      return { kind: "continue" };
    }
    case key.char === "/":
      state.filtering = true;
      return { kind: "continue" };
    default:
      return { kind: "continue" };
  }
}


function lockedSummary(count: number): string {
  return count === 1 ? "1 item never leaves this machine" : `${count} items never leave this machine`;
}

function toggle<T>(state: MultiState<T>, id: number): void {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
}

// The drawing the owner signed off: chip in the header, coach line until the
// first toggle, plain group headers with air between groups, full-row
// highlight on the active item, hints demoted to one detail line, the locked
// section a single counted line unless v expands it, and a three-entry footer
// with ? for the rest.
export function renderMulti<T>(state: MultiState<T>, theme: Theme, maxRows: number, columns = 80): string[] {
  const g = theme.glyphs;
  const bar = theme.paint("accent", g.bar);
  const visible = visibleItems(state);
  const lines: string[] = [];

  const chip = theme.paint("inverse", ` ${state.selected.size} of ${state.items.length} picked `);
  lines.push(`${theme.paint("accent", g.stepActive)}  ${theme.paint("bright", state.message)}  ${chip}`);
  if (state.filtering || state.query.length > 0) {
    lines.push(
      `${bar}  ${theme.paint("accent", "/")} ${state.query}${state.filtering ? theme.paint("inverse", " ") : ""}  ${theme.paint("dim", `${visible.length}/${state.items.length} match`)}`,
    );
  } else if (!state.touched) {
    const coach = state.coach ?? `space picks ${g.sep} enter continues with what is checked`;
    lines.push(`${bar}  ${theme.paint("warn", coach)}`);
  }
  lines.push(bar);

  const rows: string[] = [];
  let activeRow = 0;
  let lastGroup = -1;
  const labelWidth = Math.max(10, columns - 6);
  visible.forEach((item, index) => {
    if (item.groupIndex !== lastGroup) {
      if (lastGroup !== -1) rows.push(bar);
      lastGroup = item.groupIndex;
      const group = state.groups[item.groupIndex];
      if (group) rows.push(`${bar}  ${theme.paint("dim", group.title)}`);
    }
    const active = index === state.cursor;
    if (active) activeRow = rows.length;
    const mark = state.selected.has(item.id) ? g.pickOn : g.pickOff;
    if (active) {
      const content = ` ${mark} ${item.label}`.padEnd(labelWidth).slice(0, labelWidth);
      rows.push(`${bar} ${theme.paint("inverse", content)}`);
    } else {
      const painted = state.selected.has(item.id) ? theme.paint("ok", mark) : theme.paint("dim", mark);
      rows.push(`${bar}  ${painted} ${item.label}`);
    }
  });
  if (visible.length === 0) rows.push(`${bar}  ${theme.paint("dim", "No matches.")}`);

  const lockedItems = state.groups.filter((group) => group.locked === true).flatMap((group) => group.items);
  let lockedLines: string[] = [];
  if (lockedItems.length > 0) {
    if (state.lockedExpanded) {
      lockedLines.push(
        `${bar}  ${theme.paint("dim", `${g.lockedMark} ${lockedSummary(lockedItems.length)} ${g.sep} v to hide`)}`,
      );
      for (const item of lockedItems) {
        lockedLines.push(`${bar}    ${theme.paint("dim", `${g.lockedMark} ${item.label}${item.hint ? `  ${item.hint}` : ""}`)}`);
      }
    } else {
      lockedLines.push(
        `${bar}  ${theme.paint("dim", `${g.lockedMark} ${lockedSummary(lockedItems.length)} ${g.sep} v to view`)}`,
      );
    }
  }

  const sep = ` ${g.sep} `;
  const activeItem = visible[state.cursor];
  const detail =
    activeItem?.hint !== undefined && activeItem.hint.length > 0
      ? [`${bar}  ${theme.paint("dim", `${activeItem.label} ${g.sep} ${activeItem.hint}`)}`]
      : [];

  const footer: string[] = [];
  if (state.error) footer.push(`${theme.paint("warn", g.stepError)}  ${theme.paint("warn", state.error)}`);
  footer.push(
    `${theme.paint("accent", g.railEnd)}  ${theme.paint(
      "dim",
      state.helpExpanded
        ? [`${g.navUpDown} move`, "space pick", "tab next", "a group", "i invert", "/ filter", "v locked", "enter continue"].join(sep)
        : ["space pick", "enter continue", "? keys"].join(sep),
    )}`,
  );

  // Short terminals: the locked section forces back to its one-line form
  // before the list shrinks below usable, keeping footer and error visible
  // down to ~8 rows. Below that, renderLive's top-first slice cuts the
  // footer — the accepted ceiling; no interactive terminal is 7 rows tall.
  let overhead = lines.length + lockedLines.length + detail.length + footer.length + 1;
  if (lockedLines.length > 1 && overhead + 3 > maxRows) {
    lockedLines = [
      `${bar}  ${theme.paint("dim", `${g.lockedMark} ${lockedSummary(lockedItems.length)}`)}`,
    ];
    overhead = lines.length + lockedLines.length + detail.length + footer.length + 1;
  }
  const budget = Math.max(3, maxRows - overhead);
  const windowed = windowRows(rows, activeRow, budget, theme);
  return [...lines, ...windowed, bar, ...lockedLines, ...detail, ...footer];
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
        screen.renderLive(renderMulti(state, theme, Math.max(6, screen.rows - 2), screen.columns));
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
