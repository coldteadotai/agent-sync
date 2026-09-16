import type { CommandDef, ExitCode } from "../main.js";
import { defaultAgentRoots, readMarker, undoLast } from "../apply/apply.js";

const HELP = [
  "Usage: agent-sync undo [flags]",
  "",
  "Restore what the last `agent-sync apply` overwrote and remove what it created.",
  "Without --target, every agent root the tool owns is checked and any root",
  "with an apply marker is rolled back.",
  "",
  "Flags:",
  "  --target <dir>  Roll back only this directory (default: all agent roots)",
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
    if (typeof values.target === "string") {
      const result = undoLast(values.target);
      io.out(`Restored ${result.restored.length} file(s), removed ${result.removed.length} created file(s).`);
      return 0;
    }

    // A multi-agent apply leaves one marker per root; undo sweeps the same
    // default roots apply resolves and rolls back whichever it finds.
    const roots = defaultAgentRoots();
    const candidates = [...new Set([roots.claude, roots.codexHome, roots.codexAgents, roots.opencodeConfig])];
    const withMarkers = candidates.filter((root) => readMarker(root) !== null);
    if (withMarkers.length === 0) {
      throw new Error(`Nothing to undo: no apply marker in ${roots.claude} or the other agent roots.`);
    }
    for (const root of withMarkers) {
      const result = undoLast(root);
      io.out(`${root}: restored ${result.restored.length} file(s), removed ${result.removed.length} created file(s).`);
    }
    return 0;
  },
};
