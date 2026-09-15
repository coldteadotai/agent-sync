import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandDef, ExitCode } from "../main.js";
import { undoLast } from "../apply/apply.js";

const HELP = [
  "Usage: agent-sync undo [flags]",
  "",
  "Restore what the last `agent-sync apply` overwrote and remove what it created.",
  "",
  "Flags:",
  "  --target <dir>  Directory the apply ran against (default: ~/.claude, honoring CLAUDE_CONFIG_DIR)",
  "  --help          Show help",
].join("\n");

export const undoCommand: CommandDef = {
  word: "undo",
  summary: "Roll back the last apply",
  help: HELP,
  flags: {
    target: { type: "string", description: "Directory the apply ran against" },
  },
  async run({ positionals, values, io }): Promise<ExitCode> {
    if (positionals.length > 0) {
      io.err("undo: no arguments expected.");
      return 2;
    }
    const targetDir =
      typeof values.target === "string"
        ? values.target
        : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
    const result = undoLast(targetDir);
    io.out(`Restored ${result.restored.length} file(s), removed ${result.removed.length} created file(s).`);
    return 0;
  },
};
