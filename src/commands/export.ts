import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { CommandDef, ExitCode } from "../main.js";
import { collectExport, type ExportPlan } from "../export/collect.js";
import { createTar, type TarEntry } from "../export/tar.js";

const HELP = [
  "Usage: agent-sync export <dest> [flags]",
  "",
  "Pack the portable part of your Claude Code setup into a bundle.",
  "dest is a directory, a .tar or .tgz file, or - for a tar stream on stdout.",
  "",
  "Flags:",
  "  --hook <name>   Include one confirmed hook (repeatable), e.g. --hook hooks.PostToolUse",
  "  --dry-run       Print exactly what would be packed and write nothing",
  "  --json          Print the manifest as JSON instead of the summary",
  "  --help          Show help",
].join("\n");

export const exportCommand: CommandDef = {
  word: "export",
  summary: "Pack your setup into a manifest + bundle",
  help: HELP,
  flags: {
    hook: { type: "string", description: "Include one confirmed hook (repeatable)", multiple: true },
    "dry-run": { type: "boolean", description: "Print the packing list and write nothing" },
    json: { type: "boolean", description: "Print the manifest as JSON" },
  },
  async run({ positionals, values, io }): Promise<ExitCode> {
    const dryRun = values["dry-run"] === true;
    const dest = positionals[0];
    if (dest === undefined && !dryRun) {
      io.err("export: destination required (directory, .tar, .tgz, or -). Use --dry-run to preview.");
      return 2;
    }
    if (positionals.length > 1) {
      io.err("export: exactly one destination expected.");
      return 2;
    }

    const hookValues = values.hook;
    const confirmedHooks = Array.isArray(hookValues)
      ? hookValues.filter((value): value is string => typeof value === "string")
      : typeof hookValues === "string"
        ? [hookValues]
        : [];

    const plan = collectExport({ confirmedHooks });

    if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      for (const diagnostic of plan.diagnostics) io.err(`${diagnostic.severity}: ${diagnostic.message}`);
      return 2;
    }
    const manifestOnly =
      plan.entries.length === 0 &&
      (plan.manifest.mcpServers.length > 0 || plan.manifest.hooks.length > 0);
    if (plan.entries.length === 0 && !manifestOnly) {
      io.err("export: nothing to pack. Run `agent-sync scan` to see what exists.");
      return 2;
    }

    // With dest "-", stdout is the tar stream; the summary goes to stderr.
    const summarize = dest === "-" && !dryRun ? io.err : io.out;
    if (values.json) {
      summarize(
        JSON.stringify(
          { manifest: plan.manifest, skipped: plan.skipped, diagnostics: plan.diagnostics },
          null,
          2,
        ),
      );
    } else {
      summarize(renderPlan(plan, dryRun));
    }

    if (dryRun || dest === undefined) return 0;

    const manifestBytes = Buffer.from(`${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");
    if (dest === "-") {
      process.stdout.write(buildTar(plan, manifestBytes));
      return 0;
    }
    if (dest.endsWith(".tgz") || dest.endsWith(".tar.gz")) {
      writeFileSync(dest, gzipSync(buildTar(plan, manifestBytes), { level: 9 }));
      return 0;
    }
    if (dest.endsWith(".tar")) {
      writeFileSync(dest, buildTar(plan, manifestBytes));
      return 0;
    }
    writeBundleDirectory(dest, plan, manifestBytes);
    return 0;
  },
};

function buildTar(plan: ExportPlan, manifestBytes: Buffer): Buffer {
  const entries: TarEntry[] = [{ path: "manifest.json", content: manifestBytes }];
  const directories = new Set<string>(["files"]);
  for (const entry of plan.entries) {
    const parts = entry.path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(`files/${parts.slice(0, index).join("/")}`);
    }
    entries.push({ path: `files/${entry.path}`, content: entry.content, executable: entry.executable });
  }
  for (const directory of directories) entries.push({ path: directory, content: null });
  return createTar(entries);
}

function writeBundleDirectory(dest: string, plan: ExportPlan, manifestBytes: Buffer): void {
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), manifestBytes);
  for (const entry of plan.entries) {
    const target = join(dest, "files", ...entry.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
    // writeFileSync's mode applies only on creation; re-exports must correct it.
    chmodSync(target, entry.executable ? 0o755 : 0o644);
  }
}

function renderPlan(plan: ExportPlan, dryRun: boolean): string {
  const lines: string[] = [];
  const totalBytes = plan.entries.reduce((sum, entry) => sum + entry.content.length, 0);
  lines.push(
    `${dryRun ? "Would pack" : "Packing"} ${plan.entries.length} files (${totalBytes} bytes) + manifest.json`,
  );
  for (const file of plan.manifest.files) lines.push(`  ${file.path}`);
  if (plan.manifest.hooks.length > 0) {
    lines.push("", "Hooks:");
    for (const hook of plan.manifest.hooks) {
      lines.push(`  ${hook.name} — ${hook.included ? "included (confirmed via --hook)" : "left behind (pass --hook to include)"}`);
    }
  }
  if (plan.manifest.mcpServers.length > 0) {
    lines.push("", "MCP servers recorded in the manifest (names only, never applied by default):");
    for (const server of plan.manifest.mcpServers) lines.push(`  ${server.name} — ${server.status}`);
  }
  if (plan.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const skip of plan.skipped) lines.push(`  ${skip.path} — ${skip.reason}`);
  }
  for (const diagnostic of plan.diagnostics) lines.push(`${diagnostic.severity}: ${diagnostic.message}`);
  return lines.join("\n");
}
