import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { CommandIo, ExitCode } from "../main.js";
import { collectExport, skipToken, type ExportPlan } from "../export/collect.js";
import { scanClaudeCode } from "../scan/scanner.js";
import { scanCodex } from "../scan/codex.js";
import { scanOpencode } from "../scan/opencode.js";
import type { ScanItem, ScanReport } from "../scan/types.js";
import { createTheme } from "../tui/theme.js";
import { Screen } from "../tui/terminal.js";
import { createFlow, type Flow, type MultiGroup } from "../tui/components.js";
import { Plain } from "../tui/plain.js";
import { buildTar, writeBundleDirectory } from "./export.js";

export type GuidedMode = "picker" | "plain";

export interface EntryContext {
  help: boolean;
  version: boolean;
  plain: boolean;
  noInput: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  env: Record<string, string | undefined>;
}

// The entry rule, verbatim from the design doc: the picker engages only when
// both ends are TTYs, CI is unset, and nothing asked it not to. --plain is an
// explicit request and works anywhere (that is what makes it scriptable);
// env-triggered plain only replaces a picker that would otherwise have run.
export function chooseEntry(context: EntryContext): GuidedMode | "static" {
  if (context.help || context.version || context.noInput) return "static";
  if (context.plain) return "plain";
  if (!context.stdinTTY || !context.stdoutTTY || context.env.CI !== undefined) return "static";
  if (context.env.AGENT_SYNC_ACCESSIBLE === "1" || context.env.TERM === "dumb") return "plain";
  return "picker";
}

interface Selections {
  skips: string[];
  plugins: string[];
  hooks: string[];
  dest: string;
}

// The picker teaches the script: the exact non-interactive spelling of what
// the user just chose.
export function flagEcho(selections: Selections): string {
  const parts = ["agent-sync", "export", quote(selections.dest)];
  for (const skip of [...selections.skips].sort()) parts.push("--skip", quote(skip));
  for (const plugin of [...selections.plugins].sort()) parts.push("--plugin", quote(plugin));
  for (const hook of [...selections.hooks].sort()) parts.push("--hook", quote(hook));
  return parts.join(" ");
}

function quote(token: string): string {
  return /^[A-Za-z0-9@._/-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

const KIND_GROUPS: ReadonlyArray<{ kind: ScanItem["kind"]; title: string; preselected: boolean }> = [
  { kind: "skill", title: "Skills", preselected: true },
  { kind: "subagent", title: "Subagents", preselected: true },
  { kind: "command", title: "Commands", preselected: true },
  { kind: "memory", title: "Memory", preselected: true },
  { kind: "settings", title: "Settings", preselected: true },
  { kind: "plugin", title: "Plugins — declarative, re-installed by name", preselected: false },
];

export function buildTravelGroups(report: ScanReport): MultiGroup<string>[] {
  const userItems = report.items.filter((item) => item.scope === "user" && item.status === "candidate");
  const groups: MultiGroup<string>[] = [];
  for (const definition of KIND_GROUPS) {
    const items = userItems
      .filter((item) => item.kind === definition.kind)
      .map((item) => {
        const entry: MultiGroup<string>["items"][number] = {
          value: skipToken(item),
          label: item.name,
          preselected: definition.preselected,
        };
        if (item.detail !== undefined) entry.hint = item.detail;
        return entry;
      });
    if (items.length > 0) groups.push({ title: definition.title, items });
  }
  if (report.excluded.length > 0) {
    groups.push({
      title: "Never leaves this machine",
      locked: true,
      items: report.excluded.map((entry) => ({
        value: entry.path,
        label: entry.path.split("/").pop() ?? entry.path,
        hint: entry.reason,
      })),
    });
  }
  return groups;
}

export function buildHookGroup(report: ScanReport): MultiGroup<string> | null {
  const hooks = report.items.filter((item) => item.scope === "user" && item.kind === "hook");
  if (hooks.length === 0) return null;
  return {
    title: "Hooks — each runs the shell command shown",
    items: hooks.map((item) => {
      const entry: MultiGroup<string>["items"][number] = { value: item.name, label: item.name };
      if (item.detail !== undefined) entry.hint = item.detail;
      return entry;
    }),
  };
}

function factsLines(reports: ScanReport[]): string[] {
  const titles: Record<ScanReport["agent"], string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
  };
  return reports.map((report) => {
    const title = titles[report.agent].padEnd(13);
    if (!report.present) return `${title} not installed`;
    if (report.agent !== "claude-code") return `${title} found (sync lands in a later release)`;
    const userItems = report.items.filter((item) => item.scope === "user");
    const counts: string[] = [];
    for (const [kind, label] of [
      ["skill", "skills"],
      ["subagent", "subagents"],
      ["command", "commands"],
      ["memory", "memory"],
      ["settings", "settings"],
      ["hook", "hooks"],
      ["plugin", "plugins"],
      ["mcp_server", "MCP servers"],
    ] as const) {
      const total = userItems.filter((item) => item.kind === kind).length;
      if (total === 0) continue;
      counts.push(kind === "settings" || kind === "memory" ? label : `${total} ${label}`);
    }
    return `${title} ${counts.length > 0 ? counts.join(" · ") : "nothing to sync"}`;
  });
}

const DESTINATIONS = [
  { value: "setup.tgz", label: "setup.tgz", hint: "compressed bundle in this directory" },
  { value: "setup.tar", label: "setup.tar", hint: "uncompressed bundle in this directory" },
  { value: "agent-sync-bundle", label: "agent-sync-bundle/", hint: "plain directory, inspectable" },
];

export interface GuidedOverrides {
  userDir?: string;
  claudeJsonPath?: string;
  destDir?: string;
  screen?: Screen;
  plain?: Plain;
  env?: Record<string, string | undefined>;
}

export async function runGuided(io: CommandIo, mode: GuidedMode, overrides: GuidedOverrides = {}): Promise<ExitCode> {
  const scanOptions: Parameters<typeof scanClaudeCode>[0] = { projectDir: null };
  if (overrides.userDir !== undefined) scanOptions.userDir = overrides.userDir;
  if (overrides.claudeJsonPath !== undefined) scanOptions.claudeJsonPath = overrides.claudeJsonPath;
  const report = scanClaudeCode(scanOptions);
  const reports = [report, scanCodex({ projectDir: null }), scanOpencode({ projectDir: null })];

  const groups = buildTravelGroups(report);
  const hookGroup = buildHookGroup(report);
  if (groups.every((group) => group.locked === true) && hookGroup === null) {
    io.err("Nothing to sync yet. Run `agent-sync scan` to see what agent-sync looks for.");
    return 0;
  }

  const ui = mode === "picker" ? pickerUi(overrides) : plainUi(io, overrides);
  try {
    ui.intro(factsLines(reports));

    const travel = await ui.groupMultiselect("What should travel?", groups);
    if (travel === null) return 2;
    const chosen = new Set(travel);
    // Plugins are opt-in (--plugin), everything else is opt-out (--skip), so an
    // unselected plugin needs no skip token — the default already excludes it.
    const skips = groups
      .filter((group) => group.locked !== true)
      .flatMap((group) => group.items.map((item) => item.value))
      .filter((token) => !chosen.has(token) && !token.startsWith("plugin/"));
    const plugins = travel.filter((token) => token.startsWith("plugin/")).map((token) => token.slice("plugin/".length));

    let hooks: string[] = [];
    if (hookGroup !== null) {
      const picked = await ui.groupMultiselect("Which hooks may travel?", [hookGroup]);
      if (picked === null) return 2;
      hooks = picked;
    }

    const dest = await ui.select("Where should the bundle go?", DESTINATIONS);
    if (dest === null) return 2;

    const collectOptions: Parameters<typeof collectExport>[0] = {
      confirmedHooks: hooks,
      selectedPlugins: plugins,
      skips,
    };
    if (overrides.userDir !== undefined) collectOptions.userDir = overrides.userDir;
    if (overrides.claudeJsonPath !== undefined) collectOptions.claudeJsonPath = overrides.claudeJsonPath;
    const plan = collectExport(collectOptions);

    if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      for (const diagnostic of plan.diagnostics) io.err(`${diagnostic.severity}: ${diagnostic.message}`);
      return 2;
    }
    if (plan.entries.length === 0) {
      ui.outro("Nothing selected; nothing was written.");
      return 0;
    }

    const totalBytes = plan.entries.reduce((sum, entry) => sum + entry.content.length, 0);
    // The review is everything that leaves the machine, so consented hooks and
    // plugins are named here, not just counted into the file total.
    const review = [
      `Would pack ${plan.entries.length} files (${formatBytes(totalBytes)}) + manifest.json`,
      ...hooks.map((name) => `hook confirmed: ${name}`),
      ...plugins.map((name) => `plugin reference: ${name}`),
      ...plan.skipped.map((skip) => `skipped: ${skip.path} — ${skip.reason}`),
    ];
    ui.note(review);

    const confirmed = await ui.confirm(`Write ${dest === "agent-sync-bundle" ? "agent-sync-bundle/" : dest}?`);
    if (confirmed === null) return 2;
    if (!confirmed) {
      ui.outro("Nothing was written.");
      return 0;
    }

    const destPath = join(overrides.destDir ?? process.cwd(), dest);
    writeDestination(destPath, dest, plan);

    const selections: Selections = { skips, plugins, hooks, dest };
    ui.outro(
      `Packed ${plan.entries.length} files (${formatBytes(totalBytes)}) to ${dest === "agent-sync-bundle" ? "agent-sync-bundle/" : dest}`,
      `Next time, non-interactively: ${flagEcho(selections)}`,
    );
    return 0;
  } finally {
    ui.close();
  }
}

function writeDestination(destPath: string, dest: string, plan: ExportPlan): void {
  const manifestBytes = Buffer.from(`${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");
  if (dest.endsWith(".tgz")) writeFileSync(destPath, gzipSync(buildTar(plan, manifestBytes), { level: 9 }));
  else if (dest.endsWith(".tar")) writeFileSync(destPath, buildTar(plan, manifestBytes));
  else writeBundleDirectory(destPath, plan, manifestBytes);
}

function formatBytes(total: number): string {
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${Math.round(total / 1024)} KB`;
  return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

// Both modes speak the same five verbs; null means the user cancelled.
interface GuidedUi {
  intro(facts: string[]): void;
  note(lines: string[]): void;
  groupMultiselect(message: string, groups: MultiGroup<string>[]): Promise<string[] | null>;
  select(message: string, items: typeof DESTINATIONS): Promise<string | null>;
  confirm(message: string): Promise<boolean | null>;
  outro(...lines: string[]): void;
  close(): void;
}

function pickerUi(overrides: GuidedOverrides): GuidedUi {
  const theme = createTheme(overrides.env === undefined ? {} : { env: overrides.env });
  const screen = overrides.screen ?? new Screen({ ellipsis: theme.glyphs.ellipsis });
  const flow: Flow = createFlow(screen, theme);
  let open = false;
  return {
    intro(facts) {
      flow.intro("agent-sync", "guided export");
      open = true;
      flow.note(facts);
    },
    note(lines) {
      flow.note(lines);
    },
    async groupMultiselect(message, groups) {
      const result = await flow.groupMultiselect(message, groups);
      if (result.cancelled) open = false;
      return result.cancelled ? null : result.value;
    },
    async select(message, items) {
      const result = await flow.select(message, items);
      if (result.cancelled) open = false;
      return result.cancelled ? null : result.value;
    },
    async confirm(message) {
      const result = await flow.confirm(message);
      if (result.cancelled) open = false;
      return result.cancelled ? null : result.value;
    },
    outro(...lines) {
      // Lines print in order; the last one lands on the rail end, so the
      // flag-echo teaching line closes the transcript.
      if (lines.length > 1) flow.note(lines.slice(0, -1));
      flow.outro(lines[lines.length - 1] ?? "");
      open = false;
    },
    close() {
      // Cancel and outro already closed the screen through the flow.
      if (open) screen.close();
    },
  };
}

function plainUi(io: CommandIo, overrides: GuidedOverrides): GuidedUi {
  const plain = overrides.plain ?? new Plain();
  return {
    intro(facts) {
      plain.say("agent-sync (plain mode)");
      for (const fact of facts) plain.say(fact);
      plain.say("");
    },
    note(lines) {
      for (const line of lines) plain.say(line);
    },
    async groupMultiselect(message, groups) {
      const result = await plain.groupMultiselect(message, groups);
      if (result.cancelled) io.err("Cancelled. Nothing was written.");
      return result.cancelled ? null : result.value;
    },
    async select(message, items) {
      const result = await plain.select(message, items);
      if (result.cancelled) io.err("Cancelled. Nothing was written.");
      return result.cancelled ? null : result.value;
    },
    async confirm(message) {
      const result = await plain.confirm(message, true);
      if (result.cancelled) io.err("Cancelled. Nothing was written.");
      return result.cancelled ? null : result.value;
    },
    outro(...lines) {
      for (const line of lines) plain.say(line);
    },
    close() {
      // The long-lived readline interface holds stdin open; without this the
      // process never exits after the last answer.
      plain.close();
    },
  };
}
