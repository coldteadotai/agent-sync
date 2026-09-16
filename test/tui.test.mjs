import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  buildMultiState,
  colorEnabled,
  createFlow,
  createTheme,
  Plain,
  plainModeRequested,
  reduceMulti,
  renderMulti,
  Screen,
  unicodeSupported,
  visibleItems,
  visualTruncate,
  visualWidth,
} from "../dist/main.js";

const key = (name, extra = {}) => ({ name, ctrl: false, meta: false, shift: false, char: null, ...extra });
const press = (char) => key("", { char });

function asciiTheme() {
  return createTheme({ env: { NO_COLOR: "1", TERM: "xterm" }, platform: "win32", isTTY: true });
}

const GROUPS = [
  { title: "Skills", items: [{ value: "s1", label: "boxd-cli" }, { value: "s2", label: "hermes" }] },
  { title: "Plugins", items: [{ value: "p1", label: "ponytail" }] },
  {
    title: "Never leaves this machine",
    locked: true,
    lockedReason: "Credentials never sync.",
    items: [{ value: "x", label: ".credentials.json" }],
  },
];

test("theme: unicode detection and color ladder", () => {
  assert.equal(unicodeSupported({ env: {}, platform: "win32" }), false);
  assert.equal(unicodeSupported({ env: { WT_SESSION: "1" }, platform: "win32" }), true);
  assert.equal(unicodeSupported({ env: { TERM: "linux" }, platform: "linux" }), false);
  assert.equal(colorEnabled({ env: { NO_COLOR: "1", FORCE_COLOR: "1" }, isTTY: true }), false);
  assert.equal(colorEnabled({ env: { FORCE_COLOR: "1" }, isTTY: false }), true);
  assert.equal(colorEnabled({ env: { TERM: "dumb" }, isTTY: true }), false);
  const ascii = asciiTheme();
  assert.equal(ascii.glyphs.bar, "|");
  assert.equal(ascii.paint("accent", "hi"), "hi");
  const colored = createTheme({ env: { FORCE_COLOR: "1" }, platform: "darwin", isTTY: true });
  assert.match(colored.paint("accent", "hi"), /\x1b\[36mhi\x1b\[39m/);
});

test("visual width and truncation never let a line exceed budget", () => {
  assert.equal(visualWidth("plain"), 5);
  assert.equal(visualWidth("\x1b[36mhi\x1b[39m"), 2);
  assert.equal(visualWidth("你好"), 4);
  const long = "\x1b[36m" + "a".repeat(50) + "\x1b[39m";
  const cut = visualTruncate(long, 20);
  assert.ok(visualWidth(cut) <= 20);
  assert.ok(cut.includes("…"));
  assert.equal(visualTruncate("short", 20), "short");
  const wide = "字".repeat(30);
  assert.ok(visualWidth(visualTruncate(wide, 21)) <= 21);
});

test("locked groups never enter the selectable set", () => {
  const state = buildMultiState("pick", GROUPS);
  assert.equal(state.items.length, 3);
  assert.ok(!state.items.some((item) => item.label === ".credentials.json"));
});

test("multiselect reducer: toggle, tab-advance, group, invert, wrap", () => {
  const state = buildMultiState("pick", GROUPS);
  reduceMulti(state, key("space"));
  assert.deepEqual([...state.selected], [0]);
  reduceMulti(state, key("tab"));
  assert.equal(state.selected.size, 0);
  assert.equal(state.cursor, 1);
  reduceMulti(state, press("a"));
  assert.equal(state.selected.size, 2);
  reduceMulti(state, press("i"));
  assert.deepEqual([...state.selected], [2]);
  state.cursor = 0;
  reduceMulti(state, key("up"));
  assert.equal(state.cursor, 2, "cursor wraps");
  const outcome = reduceMulti(state, key("return"));
  assert.equal(outcome.kind, "submit");
  assert.deepEqual(outcome.values, ["p1"]);
});

test("filter mode: slash enters, typing filters, escape clears then cancels", () => {
  const state = buildMultiState("pick", GROUPS);
  reduceMulti(state, press("/"));
  assert.equal(state.filtering, true);
  reduceMulti(state, press("h"));
  assert.equal(visibleItems(state).length, 1);
  assert.equal(visibleItems(state)[0].label, "hermes");
  reduceMulti(state, key("backspace"));
  assert.equal(state.query, "");
  const cleared = reduceMulti(state, key("escape"));
  assert.equal(cleared.kind, "continue");
  const cancelledNow = reduceMulti(state, key("escape"));
  assert.equal(cancelledNow.kind, "cancel");
});

test("required blocks empty submit with an error", () => {
  const state = buildMultiState("pick", GROUPS, { required: true });
  const outcome = reduceMulti(state, key("return"));
  assert.equal(outcome.kind, "continue");
  assert.match(state.error, /at least one/);
});

test("renderMulti shows counts, locked section, footer, and windows long lists", () => {
  const theme = asciiTheme();
  const state = buildMultiState("What should travel?", GROUPS);
  const frame = renderMulti(state, theme, 24).join("\n");
  assert.match(frame, /What should travel\?/);
  assert.match(frame, /0 of 3 selected/);
  assert.match(frame, /Never leaves this machine/);
  assert.match(frame, /x \.credentials\.json/);
  assert.match(frame, /Credentials never sync\./);
  assert.match(frame, /enter confirm/);

  const many = [{ title: "Big", items: Array.from({ length: 40 }, (_, i) => ({ value: i, label: `item-${i}` })) }];
  const bigState = buildMultiState("big", many);
  bigState.cursor = 20;
  const windowed = renderMulti(bigState, theme, 12);
  const text = windowed.join("\n");
  assert.ok(windowed.length <= 12);
  assert.match(text, /\^ \d+ more/);
  assert.match(text, /v \d+ more/);
  assert.match(text, /item-20/);
});

function fakeScreenIo() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.resume = () => {};
  input.pause = () => {};
  input.read = () => null;
  let raw = null;
  input.setRawMode = (mode) => {
    raw = mode;
  };
  const chunks = [];
  const output = {
    write: (chunk) => chunks.push(chunk),
    columns: 60,
    rows: 24,
    isTTY: true,
    on: () => {},
    off: () => {},
  };
  return { input, output, chunks, rawState: () => raw };
}

test("screen: repaint moves up by previous rows, commit persists lines", () => {
  const { input, output, chunks } = fakeScreenIo();
  const screen = new Screen({ input, output });
  screen.renderLive(["one", "two"]);
  screen.renderLive(["three"]);
  assert.ok(chunks[1].startsWith("\r\x1b[2A\x1b[J"), "second paint climbs over the first frame");
  screen.commit(["kept"]);
  const joined = chunks.join("");
  assert.match(joined, /kept\n/);
});

test("screen: long lines are truncated below terminal width", () => {
  const { input, output, chunks } = fakeScreenIo();
  const screen = new Screen({ input, output });
  screen.renderLive(["x".repeat(500)]);
  const painted = chunks.join("");
  assert.ok(!painted.includes("x".repeat(60)), "no full-width run survives");
  assert.ok(painted.includes("…"));
});

test("flow: confirm answers via keys and stdin EOF cancels", async () => {
  const first = fakeScreenIo();
  const screen = new Screen({ input: first.input, output: first.output });
  const theme = asciiTheme();
  const flow = createFlow(screen, theme);
  flow.intro("agent-sync");
  const pending = flow.confirm("Pack it?", true);
  first.input.emit("keypress", "n", { name: "n", sequence: "n" });
  first.input.emit("keypress", undefined, { name: "return", sequence: "\r" });
  const result = await pending;
  assert.deepEqual(result, { cancelled: false, value: false });
  assert.equal(first.rawState(), true);

  const second = fakeScreenIo();
  const screen2 = new Screen({ input: second.input, output: second.output });
  const flow2 = createFlow(screen2, theme);
  flow2.intro("agent-sync");
  const pending2 = flow2.groupMultiselect("pick", GROUPS);
  second.input.emit("end");
  const cancelledResult = await pending2;
  assert.deepEqual(cancelledResult, { cancelled: true });
  assert.equal(second.rawState(), false, "terminal restored after cancel");
  assert.match(second.chunks.join(""), /Cancelled\. Nothing was written\./);
});

test("plain mode: numbered multiselect parses picks, defaults, and rejects junk", async () => {
  const input = Readable.from(["9,9\n", "1,3\n"]);
  const out = [];
  const plain = new Plain({ input, output: { write: (chunk) => out.push(chunk) } });
  const result = await plain.groupMultiselect("Select skills", [
    { title: "Skills", items: [{ value: "a", label: "one" }, { value: "b", label: "two" }, { value: "c", label: "three" }] },
    { title: "Locked", locked: true, items: [{ value: "x", label: "secret" }] },
  ]);
  assert.deepEqual(result, { cancelled: false, value: ["a", "c"] });
  const text = out.join("");
  assert.match(text, /1\. \[ \] one/);
  assert.match(text, /secret \(never included\)/);
  assert.match(text, /Use numbers between 1 and 3/);
});

test("plain mode: confirm honors default and EOF cancels", async () => {
  const plain = new Plain({ input: Readable.from(["\n"]), output: { write: () => {} } });
  assert.deepEqual(await plain.confirm("Carry hook?", false), { cancelled: false, value: false });
  const eof = new Plain({ input: Readable.from([]), output: { write: () => {} } });
  assert.deepEqual(await eof.confirm("Carry hook?"), { cancelled: true });
});

test("plainModeRequested triggers", () => {
  assert.equal(plainModeRequested({ AGENT_SYNC_ACCESSIBLE: "1" }), true);
  assert.equal(plainModeRequested({ TERM: "dumb" }), true);
  assert.equal(plainModeRequested({}), false);
});
