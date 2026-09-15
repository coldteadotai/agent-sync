import type { CommandDef, ExitCode } from "../main.js";
import { scanClaudeCode } from "../scan/scanner.js";
import type { ScanItem, ScanReport } from "../scan/types.js";

const HELP = [
  "Usage: agent-sync scan [flags]",
  "",
  "Inventory your local Claude Code setup and classify every item.",
  "Reads names and configuration structure only; no file leaves the machine.",
  "",
  "Flags:",
  "  --project <path>  Project directory to scan (default: current directory)",
  "  --no-project      Skip the project scope",
  "  --json            Print the report as JSON",
  "  --help            Show help",
].join("\n");

const STATUS_LABELS: Record<ScanItem["status"], string> = {
  candidate: "will sync",
  needs_secret: "needs secret on target",
  blocked: "will not sync",
  unsupported: "unclassified",
};

export const scanCommand: CommandDef = {
  word: "scan",
  summary: "Inventory and classify your local agent setup",
  help: HELP,
  flags: {
    project: { type: "string", description: "Project directory to scan" },
    "no-project": { type: "boolean", description: "Skip the project scope" },
    json: { type: "boolean", description: "Print the report as JSON" },
  },
  async run({ values, io }): Promise<ExitCode> {
    if (values["no-project"] && values.project !== undefined) {
      io.err("scan: --project and --no-project cannot be combined.");
      return 2;
    }
    const projectDir = values["no-project"]
      ? null
      : typeof values.project === "string"
        ? values.project
        : undefined;
    const report = scanClaudeCode(projectDir === undefined ? {} : { projectDir });

    if (values.json) {
      io.out(JSON.stringify(report, null, 2));
    } else {
      io.out(renderReport(report));
    }
    return report.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 2 : 0;
  },
};

function renderReport(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`Claude Code setup — user scope: ${report.userDir}`);
  if (report.projectDir !== null) lines.push(`Project scope: ${report.projectDir}`);
  lines.push("");

  if (report.items.length === 0) {
    lines.push("Nothing found to sync.");
  }

  for (const scope of ["user", "project"] as const) {
    const scoped = report.items.filter((item) => item.scope === scope);
    if (scoped.length === 0) continue;
    lines.push(scope === "user" ? "User" : "Project");
    for (const item of scoped) {
      const envSuffix =
        item.envRefs !== undefined && item.envRefs.length > 0 ? ` (env: ${item.envRefs.join(", ")})` : "";
      lines.push(`  ${item.kind.padEnd(11)} ${item.name} — ${STATUS_LABELS[item.status]}${envSuffix}`);
      if (item.status !== "candidate") lines.push(`              ${item.reason}`);
    }
    lines.push("");
  }

  if (report.excluded.length > 0) {
    lines.push("Excluded (never synced)");
    for (const entry of report.excluded) {
      lines.push(`  ${entry.path}`);
      lines.push(`              ${entry.reason}`);
    }
    lines.push("");
  }

  for (const diagnostic of report.diagnostics) {
    lines.push(`${diagnostic.severity}: ${diagnostic.message}`);
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
