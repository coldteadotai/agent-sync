export interface Glyphs {
  railStart: string;
  bar: string;
  railEnd: string;
  stepDone: string;
  stepActive: string;
  stepError: string;
  radioOn: string;
  radioOff: string;
  checkOn: string;
  checkOff: string;
  lockedMark: string;
  ellipsisUp: string;
  ellipsisDown: string;
  pointer: string;
  navUpDown: string;
  navLeftRight: string;
  sep: string;
  ellipsis: string;
  rule: string;
  pickOn: string;
  pickOff: string;
}

const UNICODE: Glyphs = {
  railStart: "┌",
  bar: "│",
  railEnd: "└",
  stepDone: "◇",
  stepActive: "◆",
  stepError: "■",
  radioOn: "●",
  radioOff: "○",
  checkOn: "◼",
  checkOff: "◻",
  lockedMark: "✕",
  ellipsisUp: "↑",
  ellipsisDown: "↓",
  pointer: "›",
  navUpDown: "↑↓",
  navLeftRight: "←→",
  sep: "·",
  ellipsis: "…",
  rule: "─",
  pickOn: "●",
  pickOff: "○",
};

const ASCII: Glyphs = {
  railStart: "+",
  bar: "|",
  railEnd: "+",
  stepDone: "o",
  stepActive: "*",
  stepError: "x",
  radioOn: ">",
  radioOff: " ",
  checkOn: "[x]",
  checkOff: "[ ]",
  lockedMark: "x",
  ellipsisUp: "^",
  ellipsisDown: "v",
  pointer: ">",
  navUpDown: "up/down",
  navLeftRight: "left/right",
  sep: "-",
  ellipsis: "...",
  rule: "-",
  pickOn: "[x]",
  pickOff: "[ ]",
};

export interface ThemeEnvironment {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
}

// The is-unicode-supported heuristic: on Windows only modern hosts render the
// glyph set; elsewhere everything but the bare linux console does.
export function unicodeSupported(options: ThemeEnvironment = {}): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return env.TERM !== "linux";
  return (
    Boolean(env.WT_SESSION) ||
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === "{cmd::Cmder}" ||
    env.TERM_PROGRAM === "Terminus-Sublime" ||
    env.TERM_PROGRAM === "vscode" ||
    env.TERM === "xterm-256color" ||
    env.TERM === "alacritty" ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
  );
}

// The standard ladder: NO_COLOR wins, then force-on variables, then TERM=dumb,
// then whether the stream is a terminal at all.
export function colorEnabled(options: ThemeEnvironment = {}): boolean {
  const env = options.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if ((env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") || env.CLICOLOR_FORCE === "1") return true;
  if (env.TERM === "dumb") return false;
  return options.isTTY ?? process.stderr.isTTY === true;
}

export type Style = "accent" | "dim" | "bright" | "warn" | "bad" | "ok" | "strike" | "inverse";

const CODES: Record<Style, [string, string]> = {
  accent: ["\x1b[36m", "\x1b[39m"],
  dim: ["\x1b[2m", "\x1b[22m"],
  bright: ["\x1b[1m", "\x1b[22m"],
  warn: ["\x1b[33m", "\x1b[39m"],
  bad: ["\x1b[31m", "\x1b[39m"],
  ok: ["\x1b[32m", "\x1b[39m"],
  strike: ["\x1b[9m", "\x1b[29m"],
  inverse: ["\x1b[7m", "\x1b[27m"],
};

export interface Theme {
  glyphs: Glyphs;
  unicode: boolean;
  color: boolean;
  paint(style: Style, text: string): string;
}

export function createTheme(options: ThemeEnvironment = {}): Theme {
  const unicode = unicodeSupported(options);
  const color = colorEnabled(options);
  return {
    glyphs: unicode ? UNICODE : ASCII,
    unicode,
    color,
    paint(style, text) {
      if (!color || text.length === 0) return text;
      const [open, close] = CODES[style];
      return `${open}${text}${close}`;
    },
  };
}
