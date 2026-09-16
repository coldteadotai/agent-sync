import { parseArgs } from "node:util";
import { scanCommand } from "./commands/scan.js";
import { exportCommand } from "./commands/export.js";
import { applyCommand } from "./commands/apply.js";
import { undoCommand } from "./commands/undo.js";

export { classifyMcpServer, isSensitiveKey, sanitizeRemoteEndpoint, scanSecretReferences } from "./scan/classify.js";
export { planMcpRegistrations } from "./apply/mcp.js";
export { scanClaudeCode, PORTABLE_SETTINGS_KEYS } from "./scan/scanner.js";
export { scanCodex, CODEX_PORTABLE_SETTINGS_KEYS } from "./scan/codex.js";
export { scanOpencode, OPENCODE_PORTABLE_SETTINGS_KEYS, stripJsonc } from "./scan/opencode.js";
export { parseToml } from "./scan/toml.js";
export { createTheme, unicodeSupported, colorEnabled } from "./tui/theme.js";
export { Screen, visualWidth, visualTruncate } from "./tui/terminal.js";
export { createFlow, buildMultiState, reduceMulti, renderMulti, visibleItems, cancelled, done } from "./tui/components.js";
export type { PromptResult, MultiGroup, MultiItem, Flow } from "./tui/components.js";
export { Plain, plainModeRequested } from "./tui/plain.js";
export type { ScanReport, ScanItem } from "./scan/types.js";
export { collectExport, MANIFEST_SCHEMA_VERSION } from "./export/collect.js";
export type { Manifest, ExportPlan } from "./export/collect.js";
export { createTar } from "./export/tar.js";
export { parseTar, validateArchivePath } from "./apply/untar.js";
export { loadBundleFromBuffer, loadBundleFromDirectory, assertWritablePath } from "./apply/bundle.js";
export { planApply, executeApply, gateSettingsHooks, undoLast, readMarker, resolveInside, resolveForWrite } from "./apply/apply.js";

declare const __PKG_VERSION__: string;

export type ExitCode = 0 | 2;

export interface FlagDef {
  type: "boolean" | "string";
  description: string;
  multiple?: boolean;
}

export type FlagValue = string | boolean | (string | boolean)[] | undefined;

export interface CommandIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CommandArgs {
  positionals: string[];
  values: Record<string, FlagValue>;
  io: CommandIo;
}

export interface CommandDef {
  word: string;
  summary: string;
  help: string;
  flags: Record<string, FlagDef>;
  run(args: CommandArgs): Promise<ExitCode>;
}

export const GLOBAL_FLAGS: Record<string, FlagDef> = {
  help: { type: "boolean", description: "Show help" },
  version: { type: "boolean", description: "Show version" },
};

export const ALL_COMMANDS: CommandDef[] = [scanCommand, exportCommand, applyCommand, undoCommand];

export function usage(): string {
  const lines = ["Usage: agent-sync <command> [flags]", ""];
  if (ALL_COMMANDS.length === 0) {
    lines.push("Commands: none yet. scan, export, apply and undo are in development.");
  } else {
    lines.push("Commands:");
    for (const command of ALL_COMMANDS) {
      lines.push(`  ${command.word.padEnd(10)} ${command.summary}`);
    }
  }
  lines.push("", "Flags:");
  for (const [name, flag] of Object.entries(GLOBAL_FLAGS)) {
    lines.push(`  --${name.padEnd(9)} ${flag.description}`);
  }
  return lines.join("\n");
}

const defaultIo: CommandIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export async function runCli(argv: string[], io: CommandIo = defaultIo): Promise<ExitCode> {
  const word = argv[0];
  if (word !== undefined && !word.startsWith("-")) {
    const command = ALL_COMMANDS.find((candidate) => candidate.word === word);
    if (!command) {
      io.err(`Unknown command: ${word}`);
      io.err(usage());
      return 2;
    }
    return runCommand(command, argv.slice(1), io);
  }

  let values: Record<string, FlagValue>;
  try {
    ({ values } = parseArgs({ args: argv, options: GLOBAL_FLAGS, strict: true, allowPositionals: false }));
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(usage());
    return 2;
  }

  if (values.version && !values.help) {
    io.out(__PKG_VERSION__);
    return 0;
  }
  io.out(usage());
  return 0;
}

async function runCommand(command: CommandDef, argv: string[], io: CommandIo): Promise<ExitCode> {
  let parsed: { values: Record<string, FlagValue>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_FLAGS, ...command.flags },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(command.help);
    return 2;
  }
  if (parsed.values.help) {
    io.out(command.help);
    return 0;
  }
  try {
    return await command.run({ positionals: parsed.positionals, values: parsed.values, io });
  } catch (error) {
    io.err(`${command.word}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
