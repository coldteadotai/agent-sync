import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { CommandIo, ExitCode } from "../main.js";
import { collectExport, skipToken, type ExportPlan } from "../export/collect.js";
import {
  assertPortableSettings,
  defaultAgentRoots,
  executeApply,
  gateSettingsHooks,
  gateSettingsPlugins,
  planApply,
  splitBundleByRoot,
  type AgentRoots,
} from "../apply/apply.js";
import type { LoadedBundle } from "../apply/bundle.js";
import { planMcpRegistrations, runMcpRegistration, type McpRegistration } from "../apply/mcp.js";
import type { JsonValue } from "../scan/classify.js";
import { commandSummary, scanClaudeCode } from "../scan/scanner.js";
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
  allowSecrets?: string[];
  dest: string;
}

// The picker teaches the script: the exact non-interactive spelling of what
// the user just chose.
export function flagEcho(selections: Selections): string {
  const parts = ["agent-sync", "export", quote(selections.dest)];
  for (const skip of [...selections.skips].sort()) parts.push("--skip", quote(skip));
  for (const plugin of [...selections.plugins].sort()) parts.push("--plugin", quote(plugin));
  for (const hook of [...selections.hooks].sort()) parts.push("--hook", quote(hook));
  for (const path of [...(selections.allowSecrets ?? [])].sort()) parts.push("--allow-secret", quote(path));
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

const AGENT_TITLES: Record<"codex" | "opencode", string> = {
  codex: "Codex",
  opencode: "OpenCode",
};

// The target-agents multi-select, folded into the travel picker: an agent's
// groups appear only when that agent is present with candidates, so the
// picker never shows a choice that does nothing.
export function buildTravelGroups(report: ScanReport, others: ScanReport[] = []): MultiGroup<string>[] {
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
  for (const other of others) {
    if (other.agent === "claude-code") continue;
    const agent = other.agent;
    const candidates = other.items.filter(
      (item) => item.scope === "user" && item.status === "candidate" && item.kind !== "mcp_server",
    );
    if (candidates.length === 0) continue;
    groups.push({
      title: AGENT_TITLES[agent],
      items: candidates.map((item) => {
        const entry: MultiGroup<string>["items"][number] = {
          value: skipToken(item, agent),
          label: item.name,
          hint: item.kind,
          preselected: true,
        };
        return entry;
      }),
    });
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
  codexHome?: string;
  codexAgentsDir?: string;
  opencodeConfigDir?: string;
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
  const codexScan: Parameters<typeof scanCodex>[0] = { projectDir: null };
  if (overrides.codexHome !== undefined) codexScan.codexHome = overrides.codexHome;
  if (overrides.codexAgentsDir !== undefined) codexScan.agentsDir = overrides.codexAgentsDir;
  const opencodeScan: Parameters<typeof scanOpencode>[0] = { projectDir: null };
  if (overrides.opencodeConfigDir !== undefined) opencodeScan.configDir = overrides.opencodeConfigDir;
  const reports = [report, scanCodex(codexScan), scanOpencode(opencodeScan)];

  const groups = buildTravelGroups(report, reports.slice(1));
  const hookGroup = buildHookGroup(report);
  if (groups.every((group) => group.locked === true) && hookGroup === null) {
    io.err("Nothing to sync yet. Run `agent-sync scan` to see what agent-sync looks for.");
    return 0;
  }

  const ui = mode === "picker" ? pickerUi(overrides) : plainUi(io, overrides);
  try {
    ui.intro("agent-sync", "guided export", factsLines(reports));

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
    if (overrides.codexHome !== undefined) collectOptions.codexHome = overrides.codexHome;
    if (overrides.codexAgentsDir !== undefined) collectOptions.codexAgentsDir = overrides.codexAgentsDir;
    if (overrides.opencodeConfigDir !== undefined) collectOptions.opencodeConfigDir = overrides.opencodeConfigDir;
    let plan = collectExport(collectOptions);

    // Secret findings become a consent step: refuse-by-default, carried only
    // after an explicit yes per file. The prompt names file, line and kind —
    // never the matched content.
    const allowSecrets: string[] = [];
    const flaggedPaths = [...new Set(plan.secretFindings.map((finding) => finding.path))];
    if (flaggedPaths.length > 0) {
      for (const path of flaggedPaths) {
        const findings = plan.secretFindings.filter((finding) => finding.path === path);
        const first = findings[0];
        if (first === undefined) continue;
        const where =
          findings.length === 1
            ? `line ${first.line}, ${first.kind}`
            : `line ${first.line}, ${first.kind}, +${findings.length - 1} more`;
        const consent = await ui.confirm(`${path} looks like it contains a secret (${where}). Carry it anyway?`, false);
        if (consent === null) return 2;
        if (consent) allowSecrets.push(path);
      }
      if (allowSecrets.length > 0) {
        plan = collectExport({ ...collectOptions, allowSecrets });
      }
    }

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

    const selections: Selections = { skips, plugins, hooks, allowSecrets, dest };
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

export interface ApplySelections {
  source: string;
  target?: string;
  hooks: string[];
  plugins: string[];
  mcp: string[];
}

export function applyFlagEcho(selections: ApplySelections): string {
  const parts = ["agent-sync", "apply", quote(selections.source)];
  if (selections.target !== undefined) parts.push("--target", quote(selections.target));
  for (const hook of [...selections.hooks].sort()) parts.push("--hook", quote(hook));
  for (const plugin of [...selections.plugins].sort()) parts.push("--plugin", quote(plugin));
  for (const server of [...selections.mcp].sort()) parts.push("--mcp", quote(server));
  return parts.join(" ");
}

export interface GuidedApplyOverrides {
  targetDir?: string;
  explicitTarget?: boolean;
  roots?: AgentRoots;
  screen?: Screen;
  plain?: Plain;
  env?: Record<string, string | undefined>;
  register?: (registration: McpRegistration) => void;
}

// Frame 4: plan first, consent second, writes last. The flow only collects
// answers; the writes run through the identical gate → plan → execute path
// the flags use, so it structurally cannot half-apply.
export async function runGuidedApply(
  io: CommandIo,
  mode: GuidedMode,
  bundle: LoadedBundle,
  source: string,
  overrides: GuidedApplyOverrides = {},
): Promise<ExitCode> {
  const roots = overrides.roots ?? defaultAgentRoots(overrides.targetDir);
  assertPortableSettings(bundle);

  const ui = mode === "picker" ? pickerUi(overrides) : plainUi(io, overrides);
  try {
    ui.intro("agent-sync apply", `${source} → ${roots.claude}`, []);

    // Preview per agent root, pre-consent: bundle-relative paths keep their
    // namespaces, so a codex line is self-identifying; each non-claude root
    // is named once.
    const previewSlices = splitBundleByRoot(bundle, roots);
    const previewLines: string[] = [
      `Bundle verified · ${bundle.manifest.files.length} files, every hash checked, nothing written yet`,
    ];
    let unchangedTotal = 0;
    for (const slice of previewSlices) {
      if (slice.agent !== "claude-code") previewLines.push(`${slice.agent} → ${slice.root}`);
      const preview = planApply(slice.bundle, slice.root);
      for (const action of preview.actions) {
        if (action.kind === "unchanged") {
          unchangedTotal += 1;
          continue;
        }
        const consentNote = action.path === "settings.json" ? " · final content follows your answers below" : "";
        previewLines.push(
          action.kind === "update"
            ? `update  ${action.path} (backed up first · undo restores it)${consentNote}`
            : `create  ${action.path}${consentNote}`,
        );
      }
    }
    if (unchangedTotal > 0) previewLines.push(`${unchangedTotal} unchanged`);
    ui.note(previewLines);

    const settings =
      bundle.files.has("settings.json")
        ? (JSON.parse(bundle.files.get("settings.json")!.content.toString("utf8")) as Record<string, JsonValue>)
        : {};

    const confirmedHooks: string[] = [];
    const hookNames: { name: string; command: string | null }[] = [];
    if ("statusLine" in settings) {
      hookNames.push({ name: "settings.statusLine", command: commandSummary([settings.statusLine ?? null]) });
    }
    const bundleHooks = settings.hooks;
    if (bundleHooks !== null && bundleHooks !== undefined && typeof bundleHooks === "object" && !Array.isArray(bundleHooks)) {
      for (const event of Object.keys(bundleHooks).sort()) {
        hookNames.push({ name: `hooks.${event}`, command: commandSummary([bundleHooks[event] ?? null]) });
      }
    }
    for (const hook of hookNames) {
      const consent = await ui.confirm(
        `Run ${hook.name} on this machine?${hook.command !== null ? ` (${hook.command})` : ""}`,
        false,
      );
      if (consent === null) return 2;
      if (consent) confirmedHooks.push(hook.name);
    }

    const confirmedPlugins: string[] = [];
    const enabledPlugins = settings.enabledPlugins;
    if (enabledPlugins !== null && enabledPlugins !== undefined && typeof enabledPlugins === "object" && !Array.isArray(enabledPlugins)) {
      for (const name of Object.keys(enabledPlugins).sort()) {
        const consent = await ui.confirm(`Enable plugin ${name} (installs marketplace code)?`, false);
        if (consent === null) return 2;
        if (consent) confirmedPlugins.push(name);
      }
    }

    const requestedMcp: string[] = [];
    for (const server of bundle.manifest.mcpServers) {
      if (server.status !== "candidate" || server.url === undefined) continue;
      let registration: McpRegistration | undefined;
      try {
        registration = planMcpRegistrations([server], [server.name])[0];
      } catch {
        continue;
      }
      if (registration === undefined) continue;
      const consent = await ui.confirm(
        `Register MCP server ${server.name}? (claude ${registration.args.join(" ")})`,
        false,
      );
      if (consent === null) return 2;
      if (consent) requestedMcp.push(server.name);
    }

    // Assemble done; from here it is exactly the flag path. The split runs
    // AFTER the gates because gating rewrites settings.json in the bundle,
    // and every root is planned before the first root writes.
    gateSettingsHooks(bundle, confirmedHooks);
    gateSettingsPlugins(bundle, confirmedPlugins);
    const registrations = planMcpRegistrations(bundle.manifest.mcpServers, requestedMcp);
    const slices = splitBundleByRoot(bundle, roots);
    const planned = slices.map((slice) => ({ slice, plan: planApply(slice.bundle, slice.root) }));
    let creates = 0;
    let updates = 0;
    for (const { plan } of planned) {
      creates += plan.actions.filter((action) => action.kind === "create").length;
      updates += plan.actions.filter((action) => action.kind === "update").length;
    }
    for (const { slice, plan } of planned) executeApply(slice.bundle, slice.root, plan);

    const register = overrides.register ?? runMcpRegistration;
    let failedRegistrations = 0;
    const registered: string[] = [];
    for (const registration of registrations) {
      try {
        register(registration);
        registered.push(registration.name);
      } catch (error) {
        failedRegistrations += 1;
        io.err(`apply: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const selections: ApplySelections = {
      source,
      hooks: confirmedHooks,
      plugins: confirmedPlugins,
      mcp: requestedMcp,
    };
    if (overrides.explicitTarget === true) selections.target = roots.claude;
    ui.outro(
      creates + updates === 0
        ? "Nothing to change; the bundle is already applied."
        : `Done · ${creates} created, ${updates} updated${registered.length > 0 ? `, ${registered.length} MCP registered` : ""}`,
      `Same run, scripted: ${applyFlagEcho(selections)}`,
      "agent-sync undo puts it all back.",
    );
    return failedRegistrations > 0 ? 2 : 0;
  } finally {
    ui.close();
  }
}

// Both modes speak the same five verbs; null means the user cancelled.
interface GuidedUi {
  intro(title: string, subtitle: string, facts: string[]): void;
  note(lines: string[]): void;
  groupMultiselect(message: string, groups: MultiGroup<string>[]): Promise<string[] | null>;
  select(message: string, items: typeof DESTINATIONS): Promise<string | null>;
  confirm(message: string, initial?: boolean): Promise<boolean | null>;
  outro(...lines: string[]): void;
  close(): void;
}

function pickerUi(overrides: GuidedOverrides): GuidedUi {
  const theme = createTheme(overrides.env === undefined ? {} : { env: overrides.env });
  const screen = overrides.screen ?? new Screen({ ellipsis: theme.glyphs.ellipsis });
  const flow: Flow = createFlow(screen, theme);
  let open = false;
  return {
    intro(title, subtitle, facts) {
      flow.intro(title, subtitle);
      open = true;
      if (facts.length > 0) flow.note(facts);
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
    async confirm(message, initial = true) {
      const result = await flow.confirm(message, initial);
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
    intro(title, subtitle, facts) {
      plain.say(`${title} — ${subtitle} (plain mode)`);
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
    async confirm(message, initial = true) {
      const result = await plain.confirm(message, initial);
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
