import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandDef, ExitCode } from "../main.js";
import { loadBundleFromBuffer, loadBundleFromDirectory, type LoadedBundle } from "../apply/bundle.js";
import { executeApply, planApply } from "../apply/apply.js";

const HELP = [
  "Usage: agent-sync apply <bundle> [flags]",
  "",
  "Unpack a bundle into the target directory. Every file is verified against",
  "its manifest hash before anything is written, and what gets overwritten is",
  "backed up first so `agent-sync undo` can put it back.",
  "bundle is a directory, a .tar or .tgz file, or - for a tar stream on stdin.",
  "",
  "Flags:",
  "  --target <dir>  Directory to apply into (default: ~/.claude, honoring CLAUDE_CONFIG_DIR)",
  "  --dry-run       Print what would change and write nothing",
  "  --help          Show help",
].join("\n");

export const applyCommand: CommandDef = {
  word: "apply",
  summary: "Apply a bundle to this machine, with backup and verification",
  help: HELP,
  flags: {
    target: { type: "string", description: "Directory to apply into" },
    "dry-run": { type: "boolean", description: "Print what would change and write nothing" },
  },
  async run({ positionals, values, io }): Promise<ExitCode> {
    const source = positionals[0];
    if (source === undefined || positionals.length > 1) {
      io.err("apply: exactly one bundle expected (directory, .tar, .tgz, or -).");
      return 2;
    }
    const targetDir =
      typeof values.target === "string"
        ? values.target
        : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));

    const bundle = await loadBundle(source);
    const plan = planApply(bundle, targetDir);

    const creates = plan.actions.filter((action) => action.kind === "create");
    const updates = plan.actions.filter((action) => action.kind === "update");
    const dryRun = values["dry-run"] === true;

    if (plan.previousMarker !== null && plan.addedSinceLast.length > 0) {
      io.out(
        `${plan.addedSinceLast.length} new since last apply: ${plan.addedSinceLast.join(", ")}`,
      );
    }
    if (creates.length === 0 && updates.length === 0) {
      io.out(`Nothing to change in ${targetDir}; the bundle is already applied.`);
      return 0;
    }

    io.out(`${dryRun ? "Would apply" : "Applying"} to ${targetDir}:`);
    for (const action of plan.actions) {
      if (action.kind !== "unchanged") io.out(`  ${action.kind.padEnd(7)} ${action.path}`);
    }
    if (dryRun) return 0;

    const marker = executeApply(bundle, targetDir, plan);
    if (marker !== null && marker.updated.length > 0) {
      io.out(`Backed up ${marker.updated.length} overwritten file(s); \`agent-sync undo\` restores them.`);
    }
    io.out(`Done: ${creates.length} created, ${updates.length} updated.`);
    return 0;
  },
};

async function loadBundle(source: string): Promise<LoadedBundle> {
  if (source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return loadBundleFromBuffer(Buffer.concat(chunks));
  }
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (stat === undefined) throw new Error(`${source} does not exist.`);
  if (stat.isDirectory()) return loadBundleFromDirectory(source);
  return loadBundleFromBuffer(readFileSync(source));
}
