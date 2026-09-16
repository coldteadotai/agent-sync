import type { Theme } from "./theme.js";

// The launch wordmark: AGENT SYNC in a 4x5 pixel font, drawn as three
// terminal rows of half-block cells so the aspect reads as tiles rather than
// stretched columns. ASCII mode gets plain bold text; a narrow terminal gets
// the same, because a clipped wordmark is worse than none.
const FONT: Record<string, string[]> = {
  A: ["0110", "1001", "1111", "1001", "1001"],
  G: ["0111", "1000", "1011", "1001", "0111"],
  E: ["1111", "1000", "1110", "1000", "1111"],
  N: ["1001", "1101", "1111", "1011", "1001"],
  T: ["1111", "0100", "0100", "0100", "0100"],
  S: ["0111", "1000", "0110", "0001", "1110"],
  Y: ["1001", "1001", "0110", "0100", "0100"],
  C: ["0111", "1000", "1000", "1000", "0111"],
  " ": ["00", "00", "00", "00", "00"],
};

const WORD = "AGENT SYNC";

export function wordmarkWidth(): number {
  let width = 0;
  for (const character of WORD) width += (FONT[character]?.[0]?.length ?? 0) + 1;
  return width - 1;
}

export function wordmarkLines(theme: Theme, columns: number): string[] {
  if (!theme.unicode || columns < wordmarkWidth() + 4) {
    return [theme.paint("bright", WORD)];
  }
  const pixelRows: string[] = ["", "", "", "", ""];
  for (const character of WORD) {
    const glyph = FONT[character];
    if (glyph === undefined) continue;
    for (let row = 0; row < 5; row += 1) pixelRows[row] += `${glyph[row]}0`;
  }
  const lines: string[] = [];
  for (const [top, bottom] of [
    [0, 1],
    [2, 3],
    [4, -1],
  ] as const) {
    let line = "";
    const width = pixelRows[0]?.length ?? 0;
    for (let column = 0; column < width; column += 1) {
      const upper = pixelRows[top]?.[column] === "1";
      const lower = bottom >= 0 && pixelRows[bottom]?.[column] === "1";
      line += upper && lower ? "█" : upper ? "▀" : lower ? "▄" : " ";
    }
    lines.push(theme.paint("bright", line.replace(/\s+$/, "")));
  }
  return lines;
}
